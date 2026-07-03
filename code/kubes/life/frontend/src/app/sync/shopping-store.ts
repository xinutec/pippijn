import { Injectable, inject, signal } from '@angular/core';
import { Observable, from } from 'rxjs';
import { map, shareReplay, switchMap } from 'rxjs/operators';
import { ulid } from 'ulid';
import { type RxCollection, type RxJsonSchema } from 'rxdb';

import { ConflictReporter, makeConflictHandler } from './conflict-merge';
import { startHttpReplication } from './replication';
import { LifeDb } from './life-db';
import { SyncStatus } from './sync-status';

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
  private syncStatus = inject(SyncStatus);
  private readonly collection = this.init();
  private replication?: ReturnType<typeof startHttpReplication<ShoppingDoc>>;

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
    this.replication = startHttpReplication<ShoppingDoc>({
      collection,
      // '-v2': replication-state reset after the isEqual push-loss bug — see
      // the comment in wellbeing-store.ts.
      identifier: 'shopping-http-sync-v2',
      path: '/api/sync/shopping',
      syncError: this.syncError,
      syncStatus: this.syncStatus,
      label: 'shopping sync',
    });
  }
}
