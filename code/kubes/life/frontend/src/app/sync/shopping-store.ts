import { Injectable, inject, signal } from '@angular/core';
import { Observable, from } from 'rxjs';
import { map, shareReplay, switchMap } from 'rxjs/operators';
import { ulid } from 'ulid';
import { type RxCollection, type RxJsonSchema } from 'rxdb';
import { replicateRxCollection } from 'rxdb/plugins/replication';

import { ConflictReporter, makeConflictHandler } from './conflict-merge';
import { LifeDb } from './life-db';

/** A shopping row as stored locally. `ulid` is the stable identity; `rev` is the
 *  last server revision seen (set by sync, not by local edits); `id` is the
 *  server autoincrement (null until synced) used only to bridge the legacy
 *  /buy endpoint. RxDB manages `_deleted` (tombstone) + its own internal fields. */
export interface ShoppingDoc {
  ulid: string;
  id: number | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  barcode: string | null;
  done: boolean;
  rev: number;
}

type ShoppingCollection = RxCollection<ShoppingDoc>;

const schema: RxJsonSchema<ShoppingDoc> = {
  version: 0,
  primaryKey: 'ulid',
  type: 'object',
  properties: {
    ulid: { type: 'string', maxLength: 26 },
    id: { type: ['integer', 'null'] },
    name: { type: 'string' },
    quantity: { type: ['number', 'null'] },
    unit: { type: ['string', 'null'] },
    barcode: { type: ['string', 'null'] },
    done: { type: 'boolean' },
    rev: { type: 'number' },
  },
  required: ['ulid', 'name', 'done', 'rev'],
};

/** The content fields the 3-way merge diffs (see [[makeConflictHandler]]) —
 *  also the allowlist the Conflicts screen may patch on "use other". */
export const SHOPPING_MERGE_FIELDS = ['name', 'quantity', 'unit', 'barcode', 'done'] as const;

/** Local-first store for the shopping list: the on-device RxDB collection is the
 *  source of truth; replication reconciles with /api/sync/shopping in the
 *  background. Reads are reactive and offline; writes are local + optimistic. */
@Injectable({ providedIn: 'root' })
export class ShoppingStore {
  /** null = ok; a string = a sync problem to surface (e.g. login required). */
  readonly syncError = signal<string | null>(null);

  private lifeDb = inject(LifeDb);
  private reporter = inject(ConflictReporter);
  private readonly collection = this.init();
  private replication?: ReturnType<typeof replicateRxCollection<ShoppingDoc, { rev: number }>>;

  /** Live, sorted, non-deleted shopping rows (RxDB filters tombstones). */
  readonly items$: Observable<ShoppingDoc[]> = from(this.collection).pipe(
    switchMap((col) => col.find({ sort: [{ done: 'asc' }, { name: 'asc' }] }).$),
    map((docs) => docs.map((d) => d.toJSON() as ShoppingDoc)),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  async add(input: {
    name: string;
    quantity: number | null;
    unit: string | null;
    barcode: string | null;
  }): Promise<void> {
    const col = await this.collection;
    await col.insert({
      ulid: ulid(),
      id: null,
      name: input.name,
      quantity: input.quantity,
      unit: input.unit,
      barcode: input.barcode,
      done: false,
      rev: 0,
    });
  }

  async setDone(key: string, done: boolean): Promise<void> {
    await this.patch(key, { done });
  }

  async patch(
    key: string,
    fields: Partial<Pick<ShoppingDoc, (typeof SHOPPING_MERGE_FIELDS)[number]>>,
  ): Promise<void> {
    const doc = await this.find(key);
    await doc?.incrementalPatch(fields);
  }

  async remove(key: string): Promise<void> {
    const doc = await this.find(key);
    await doc?.remove();
  }

  /** Bring a just-removed doc back locally under the same ulid (insert after
   *  remove revives the RxDB tombstone). Works offline — the Undo snackbar's
   *  first layer; the server-side trash restore is the authoritative second. */
  async revive(doc: ShoppingDoc): Promise<void> {
    const col = await this.collection;
    await col.insert({ ...doc });
  }

  /** Ask replication to pull now — e.g. right after a server-side trash restore,
   *  so the resurrected row appears without waiting for the next natural sync. */
  reSync(): void {
    this.replication?.reSync();
  }

  /** Remove every ticked-off row (local; syncs as tombstones). */
  async clearDone(): Promise<void> {
    const col = await this.collection;
    await col.find({ selector: { done: true } }).remove();
  }

  private async find(key: string) {
    const col = await this.collection;
    return col.findOne(key).exec();
  }

  private async init(): Promise<ShoppingCollection> {
    // Field-level 3-way merge: concurrent edits to different fields both
    // survive; same-field collisions keep this device's value and land in the
    // server-side conflict log for review.
    const handler = makeConflictHandler<ShoppingDoc>({
      fields: SHOPPING_MERGE_FIELDS,
      onConflicts: (kept, conflicts) =>
        this.reporter.report('shopping', kept.ulid, kept.name, conflicts),
    });
    const col = await this.lifeDb.collection('shopping', schema, handler);
    this.startReplication(col);
    return col;
  }

  private startReplication(collection: ShoppingCollection): void {
    const guardAuth = (res: Response) => {
      // An expired session shows up two ways: our API returns 401/403 JSON, or a
      // stale cookie 302-redirects to a login page that fetch follows to a 200
      // non-JSON body. Either way, surface "login required" and fail so RxDB
      // retries without corrupting the queue. Must run BEFORE the generic
      // !res.ok check so this friendly message wins over "pull failed: 401".
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 401 || res.status === 403 || res.redirected || !ct.includes('application/json')) {
        this.syncError.set('login required — reopen the app to sign in');
        throw new Error('auth-required');
      }
    };

    const replication = replicateRxCollection<ShoppingDoc, { rev: number }>({
      collection,
      replicationIdentifier: 'shopping-http-sync',
      live: true,
      retryTime: 5000,
      pull: {
        batchSize: 200,
        handler: async (checkpoint, batchSize) => {
          const since = checkpoint?.rev ?? 0;
          const res = await fetch(
            `/api/sync/shopping?since=${since}&limit=${batchSize}`,
            { credentials: 'include' },
          );
          guardAuth(res);
          if (!res.ok) throw new Error(`pull failed: ${res.status}`);
          const body = (await res.json()) as {
            documents: (ShoppingDoc & { _deleted: boolean })[];
            checkpoint: { rev: number };
          };
          this.syncError.set(null);
          return { documents: body.documents, checkpoint: body.checkpoint };
        },
      },
      push: {
        batchSize: 50,
        handler: async (rows) => {
          const res = await fetch('/api/sync/shopping', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(rows),
          });
          guardAuth(res);
          if (!res.ok) throw new Error(`push failed: ${res.status}`);
          this.syncError.set(null);
          return (await res.json()) as (ShoppingDoc & { _deleted: boolean })[];
        },
      },
    });
    replication.error$.subscribe((err) => {
      // Keep the auth message if that's the cause; otherwise stay quiet (RxDB
      // retries transient network errors on its own).
      if (this.syncError() === null) {
        console.warn('[shopping sync]', err);
      }
    });
    this.replication = replication;
  }
}
