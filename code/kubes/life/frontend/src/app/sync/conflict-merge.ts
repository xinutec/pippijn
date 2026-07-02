import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import type { RxConflictHandler } from 'rxdb';

import { LifeApi } from '../life-api';
import { ConflictKind } from '../models';

/** One same-field collision the merge had to decide: `mine` was kept (the
 *  pushing device's latest intent), `theirs` lost and gets logged. */
export interface FieldConflict {
  field: string;
  mine: unknown;
  theirs: unknown;
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
}): RxConflictHandler<T> {
  return {
    isEqual: (a, b) => a.rev === b.rev && !!a._deleted === !!b._deleted,
    resolve: ({ realMasterState: real, newDocumentState: mine, assumedMasterState: assumed }) => {
      if (real._deleted) return Promise.resolve(real);
      if (!assumed) return Promise.resolve(mine); // no base to diff against
      const merged = { ...real };
      const conflicts: FieldConflict[] = [];
      for (const f of opts.fields) {
        if (Object.is(mine[f], assumed[f])) continue; // I didn't touch it → theirs
        if (!Object.is(real[f], assumed[f]) && !Object.is(mine[f], real[f])) {
          conflicts.push({ field: f, mine: mine[f], theirs: real[f] });
        }
        merged[f] = mine[f];
      }
      if (mine._deleted) merged._deleted = true;
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
    this.snack
      .open(`Edits collided on “${label}” — kept this device's version.`, 'Review', {
        duration: 8000,
      })
      .onAction()
      .subscribe(() => void this.router.navigate(['/conflicts']));
  }
}
