import { WritableSignal } from '@angular/core';
import { RxCollection } from 'rxdb';
import { replicateRxCollection } from 'rxdb/plugins/replication';

import { SyncStatus } from './sync-status';

/** Auth guard for sync fetches. An expired session shows up two ways: our API
 *  returns 401/403 JSON, or a stale cookie 302-redirects to a login page that
 *  fetch follows to a 200 non-JSON body. Either way, surface "login required"
 *  and throw so RxDB retries without corrupting the queue. Must run BEFORE the
 *  generic !res.ok check so this friendly message wins over "pull failed: 401".
 *  Pure(ish) and exported so the branching is unit-testable. */
export function guardAuth(res: Response, syncError: WritableSignal<string | null>): void {
  const ct = res.headers.get('content-type') ?? '';
  if (res.status === 401 || res.status === 403 || res.redirected || !ct.includes('application/json')) {
    syncError.set('login required — reopen the app to sign in');
    throw new Error('auth-required');
  }
}

/** Start the standard HTTP pull/push replication every synced collection uses
 *  (see docs/proposals/offline-first.md). One implementation instead of three
 *  copies — the shape is identical per collection: GET `path?since&limit` for
 *  pulls, POST `path` with the RxDB rows for pushes, rev-checkpointing, the
 *  auth guard, and quiet retry on transient errors. */
export function startHttpReplication<T>(opts: {
  collection: RxCollection<T>;
  /** Stable RxDB replication identity, e.g. 'shopping-http-sync'. */
  identifier: string;
  /** Sync endpoint, e.g. '/api/sync/shopping'. */
  path: string;
  /** The owning store's user-facing sync problem signal. */
  syncError: WritableSignal<string | null>;
  /** App-wide sync-health aggregator — every cycle reports success/failure here
   *  so the shell can show a persistent "not synced" indicator. */
  syncStatus: SyncStatus;
  /** console.warn tag + sync-status source key, e.g. 'shopping sync'. */
  label: string;
}) {
  const replication = replicateRxCollection<T, { rev: number }>({
    collection: opts.collection,
    replicationIdentifier: opts.identifier,
    live: true,
    retryTime: 5000,
    pull: {
      batchSize: 200,
      handler: async (checkpoint, batchSize) => {
        const since = checkpoint?.rev ?? 0;
        const res = await fetch(`${opts.path}?since=${since}&limit=${batchSize}`, {
          credentials: 'include',
        });
        guardAuth(res, opts.syncError);
        if (!res.ok) throw new Error(`pull failed: ${res.status}`);
        const body = (await res.json()) as {
          documents: (T & { _deleted: boolean })[];
          checkpoint: { rev: number };
        };
        opts.syncError.set(null);
        opts.syncStatus.clearError(opts.label);
        return { documents: body.documents, checkpoint: body.checkpoint };
      },
    },
    push: {
      batchSize: 50,
      handler: async (rows) => {
        const res = await fetch(opts.path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(rows),
        });
        guardAuth(res, opts.syncError);
        if (!res.ok) throw new Error(`push failed: ${res.status}`);
        opts.syncError.set(null);
        opts.syncStatus.clearError(opts.label);
        return (await res.json()) as (T & { _deleted: boolean })[];
      },
    },
  });
  replication.error$.subscribe((err) => {
    // Surface every failed cycle to the app-wide indicator. The auth guard sets
    // a friendly syncError; for anything else (server down, 5xx, offline fetch)
    // use a reassuring generic — offline-first means the write is safe locally.
    const message =
      opts.syncError() ??
      'Can’t reach the server — changes are saved on this device and will sync when it’s back.';
    opts.syncStatus.reportError(opts.label, message);
    // Keep the console breadcrumb only for the non-auth case (RxDB retries
    // transient network errors on its own).
    if (opts.syncError() === null) {
      console.warn(`[${opts.label}]`, err);
    }
  });
  return replication;
}
