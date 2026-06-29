import { Injectable, isDevMode, signal } from '@angular/core';
import { Observable, from } from 'rxjs';
import { map, shareReplay, switchMap } from 'rxjs/operators';
import { ulid } from 'ulid';
import {
  addRxPlugin,
  createRxDatabase,
  type RxCollection,
  type RxConflictHandler,
  type RxDatabase,
  type RxJsonSchema,
} from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { replicateRxCollection } from 'rxdb/plugins/replication';

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
type ShoppingDatabase = RxDatabase<{ shopping: ShoppingCollection }>;

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

// Single user: a conflict means the same row was edited on two devices while one
// was offline. Policy: a delete is *sticky* (a tombstone is never resurrected by a
// later edit); otherwise the local change — the user's latest intent — wins and is
// re-pushed. (See docs/proposals/offline-first.md, review K4/S9.)
const conflictHandler: RxConflictHandler<ShoppingDoc> = {
  isEqual: (a, b) => a.rev === b.rev && !!a._deleted === !!b._deleted,
  resolve: ({ realMasterState, newDocumentState }) =>
    Promise.resolve(realMasterState._deleted ? realMasterState : newDocumentState),
};

/** Local-first store for the shopping list: the on-device RxDB collection is the
 *  source of truth; replication reconciles with /api/sync/shopping in the
 *  background. Reads are reactive and offline; writes are local + optimistic. */
@Injectable({ providedIn: 'root' })
export class ShoppingStore {
  /** null = ok; a string = a sync problem to surface (e.g. login required). */
  readonly syncError = signal<string | null>(null);

  private readonly db = this.init();

  /** Live, sorted, non-deleted shopping rows (RxDB filters tombstones). */
  readonly items$: Observable<ShoppingDoc[]> = from(this.db).pipe(
    switchMap((db) =>
      db.shopping.find({ sort: [{ done: 'asc' }, { name: 'asc' }] }).$,
    ),
    map((docs) => docs.map((d) => d.toJSON() as ShoppingDoc)),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  async add(input: {
    name: string;
    quantity: number | null;
    unit: string | null;
    barcode: string | null;
  }): Promise<void> {
    const db = await this.db;
    await db.shopping.insert({
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
    const doc = await this.find(key);
    await doc?.incrementalPatch({ done });
  }

  async remove(key: string): Promise<void> {
    const doc = await this.find(key);
    await doc?.remove();
  }

  /** Remove every ticked-off row (local; syncs as tombstones). */
  async clearDone(): Promise<void> {
    const db = await this.db;
    await db.shopping.find({ selector: { done: true } }).remove();
  }

  private async find(key: string) {
    const db = await this.db;
    return db.shopping.findOne(key).exec();
  }

  private async init(): Promise<ShoppingDatabase> {
    if (isDevMode()) {
      const { RxDBDevModePlugin } = await import('rxdb/plugins/dev-mode');
      addRxPlugin(RxDBDevModePlugin);
    }
    const db = await createRxDatabase<{ shopping: ShoppingCollection }>({
      name: 'lifedb',
      storage: getRxStorageDexie(),
      multiInstance: true,
      // Tolerate hot-reload re-creates in dev; harmless in prod (single instance).
      ignoreDuplicate: isDevMode(),
    });
    await db.addCollections({ shopping: { schema, conflictHandler } });
    this.startReplication(db.shopping);
    return db;
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
  }
}
