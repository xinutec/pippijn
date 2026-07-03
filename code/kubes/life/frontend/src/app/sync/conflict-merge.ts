import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import type { RxConflictHandler } from 'rxdb';

import { Alerts } from '../shared/alerts';
import { LifeApi } from '../life-api';
import { ConflictKind } from '../models';

/** One same-field collision the merge had to decide: `mine` was kept (the
 *  pushing device's latest intent), `theirs` lost and gets logged. */
export interface FieldConflict {
  field: string;
  mine: unknown;
  theirs: unknown;
}

/** A per-document record of what `resolve()` actually did — the merge path is
 *  otherwise invisible (the isEqual push-loss bug went undetected precisely
 *  because nothing here logs). `mine`/`theirs`/`collided` name the fields that
 *  resolved each way, so a stray edit "disturbed" by a merge leaves a trace. */
export interface MergeTrace {
  ulid: string;
  /** Fields taken from this device (I changed them since the assumed base). */
  mine: string[];
  /** Fields left to the server value that the OTHER device changed — the branch
   *  that pulls in remote edits; the one to watch for clobbered local work. */
  theirs: string[];
  /** Fields both sides changed to different values: local won, server logged. */
  collided: string[];
  /** The whole doc resolved to a tombstone (a delete won). */
  deleted: boolean;
  /** No assumed base to diff against → the local doc won wholesale. */
  noBase: boolean;
}

/** Default merge observer: DevTools "Verbose"-level only, so it's silent in
 *  normal use but readable over CDP when diagnosing a sync. */
function logMergeTrace(t: MergeTrace): void {
  console.debug('[conflict:resolve]', t.ulid, {
    mine: t.mine,
    theirs: t.theirs,
    collided: t.collided,
    ...(t.deleted ? { deleted: true } : {}),
    ...(t.noBase ? { noBase: true } : {}),
  });
}

/** Build a field-level 3-way-merge conflict handler for a synced collection.
 *
 *  A conflict means the same row changed on two devices while one was offline.
 *  The old whole-document rule (local wins) silently dropped the other
 *  device's edits even on fields this device never touched. Instead, diff
 *  against the assumed base (the state this device last synced):
 *
 *  - a field only I changed → mine;
 *  - a field only they changed → theirs — nothing of theirs is lost anymore;
 *  - a field we BOTH changed → mine (the user pushing is the latest intent),
 *    and the losing value is handed to `onConflicts` for the conflict log —
 *    decided, but never silently discarded.
 *
 *  Deletes: a server tombstone stands (the server is set-only — a push can't
 *  clear it; the trash restore is the one undelete), and a local delete stands
 *  over remote edits. Identity/server fields (ulid, id, rev) always come from
 *  the real master. */
export function makeConflictHandler<T extends { rev: number }>(opts: {
  fields: readonly (keyof T & string)[];
  onConflicts?: (kept: T & { _deleted: boolean }, conflicts: FieldConflict[]) => void;
  /** Observe every resolve() decision. Defaults to a `console.debug` trace;
   *  a test injects a spy to assert the merge disturbed no local edit. */
  trace?: (t: MergeTrace) => void;
}): RxConflictHandler<T> {
  const trace = opts.trace ?? logMergeTrace;
  return {
    /** Replication equality. RxDB asks this in BOTH directions, and the
     *  upstream one is load-bearing: `isEqual(assumedMaster, current,
     *  'upstream-check-if-equal')` decides whether a local doc still needs
     *  pushing — `false` is what queues the push. Revs are server-minted, so
     *  a local edit changes content but NOT `rev`; comparing rev alone judged
     *  every field edit "already replicated" and silently dropped it (the
     *  2026-07-03 push-loss bug — see replication-push.spec.ts). The content
     *  fields must be compared too. `?? null` folds undefined into null so an
     *  absent optional equals the wire's explicit null. */
    isEqual: (a, b) =>
      !!a._deleted === !!b._deleted &&
      (!!a._deleted ||
        (a.rev === b.rev && opts.fields.every((f) => Object.is(a[f] ?? null, b[f] ?? null)))),
    resolve: ({ realMasterState: real, newDocumentState: mine, assumedMasterState: assumed }) => {
      const id = (mine as { ulid?: string }).ulid ?? '?';
      if (real._deleted) {
        trace({ ulid: id, mine: [], theirs: [], collided: [], deleted: true, noBase: false });
        return Promise.resolve(real);
      }
      if (!assumed) {
        // No base to diff against → the local doc wins wholesale.
        trace({ ulid: id, mine: [], theirs: [], collided: [], deleted: !!mine._deleted, noBase: true });
        return Promise.resolve(mine);
      }
      const merged = { ...real };
      const conflicts: FieldConflict[] = [];
      const tookMine: string[] = [];
      const tookTheirs: string[] = [];
      for (const f of opts.fields) {
        if (Object.is(mine[f], assumed[f])) {
          // I didn't touch it → keep the master's value; note when that pulls
          // in a genuine remote change (real ≠ base), not just an unchanged field.
          if (!Object.is(real[f], assumed[f])) tookTheirs.push(f);
          continue;
        }
        if (!Object.is(real[f], assumed[f]) && !Object.is(mine[f], real[f])) {
          conflicts.push({ field: f, mine: mine[f], theirs: real[f] });
        }
        merged[f] = mine[f];
        tookMine.push(f);
      }
      if (mine._deleted) merged._deleted = true;
      trace({
        ulid: id,
        mine: tookMine,
        theirs: tookTheirs,
        collided: conflicts.map((c) => c.field),
        deleted: !!mine._deleted,
        noBase: false,
      });
      if (conflicts.length > 0) opts.onConflicts?.(mine, conflicts);
      return Promise.resolve(merged);
    },
  };
}

/** Sends same-field conflicts to the server-side conflict log (so every device
 *  can review them) and points the user at the Conflicts screen. */
@Injectable({ providedIn: 'root' })
export class ConflictReporter {
  private api = inject(LifeApi);
  private snack = inject(MatSnackBar);
  private router = inject(Router);
  private alerts = inject(Alerts);

  report(kind: ConflictKind, ulid: string, label: string, conflicts: FieldConflict[]): void {
    for (const c of conflicts) {
      this.api
        .reportConflict({
          kind,
          ulid,
          field: c.field,
          label,
          mine: JSON.stringify(c.mine ?? null),
          theirs: JSON.stringify(c.theirs ?? null),
        })
        .subscribe({
          // The merge already happened; a failed report only loses the log
          // entry. Warn instead of interrupting sync.
          error: () => console.warn('[conflict] report failed', kind, ulid, c.field),
        });
    }
    this.alerts.addConflicts(conflicts.length); // badge appears immediately
    this.snack
      .open(`Edits collided on “${label}” — kept this device's version.`, 'Review', {
        duration: 8000,
      })
      .onAction()
      .subscribe(() => void this.router.navigate(['/conflicts']));
  }
}
