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

import { TodoStatus, TodoType } from '../models';

/** A to-do row as stored locally. `ulid` is the stable identity; `rev` is the
 *  last server revision seen (set by sync, not local edits); `id` is the server
 *  autoincrement (null until synced). RxDB manages `_deleted` + internal fields.
 *  Mirrors the backend `TodoDoc` wire shape. */
export interface TodoDoc {
  ulid: string;
  id: number | null;
  title: string;
  type: TodoType;
  status: TodoStatus;
  notes: string | null;
  rev: number;
}

type TodoCollection = RxCollection<TodoDoc>;
type TodoDatabase = RxDatabase<{ todo: TodoCollection }>;

const schema: RxJsonSchema<TodoDoc> = {
  version: 0,
  primaryKey: 'ulid',
  type: 'object',
  properties: {
    ulid: { type: 'string', maxLength: 26 },
    id: { type: ['integer', 'null'] },
    title: { type: 'string' },
    type: { type: 'string', enum: ['purchase', 'call'], maxLength: 16 },
    status: { type: 'string', enum: ['open', 'done'], maxLength: 8 },
    notes: { type: ['string', 'null'] },
    rev: { type: 'number' },
  },
  required: ['ulid', 'title', 'type', 'status', 'rev'],
};

// Single user: a conflict means the same to-do was edited on two devices while
// one was offline. Policy mirrors shopping — a delete is sticky (a tombstone is
// never resurrected); otherwise the local change (latest intent) wins.
export const conflictHandler: RxConflictHandler<TodoDoc> = {
  isEqual: (a, b) => a.rev === b.rev && !!a._deleted === !!b._deleted,
  resolve: ({ realMasterState, newDocumentState }) =>
    Promise.resolve(realMasterState._deleted ? realMasterState : newDocumentState),
};

/** Local-first store for the to-do list: the on-device RxDB collection is the
 *  source of truth; replication reconciles with /api/sync/todo in the background.
 *  Reads are reactive and offline; writes are local + optimistic. */
@Injectable({ providedIn: 'root' })
export class TodoStore {
  /** null = ok; a string = a sync problem to surface (e.g. login required). */
  readonly syncError = signal<string | null>(null);

  private readonly db = this.init();

  /** Live, sorted, non-deleted to-dos: open before done, then by title. */
  readonly items$: Observable<TodoDoc[]> = from(this.db).pipe(
    switchMap((db) => db.todo.find({ sort: [{ status: 'desc' }, { title: 'asc' }] }).$),
    map((docs) => docs.map((d) => d.toJSON() as TodoDoc)),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  async add(input: { title: string; type: TodoType; notes: string | null }): Promise<void> {
    const db = await this.db;
    await db.todo.insert({
      ulid: ulid(),
      id: null,
      title: input.title,
      type: input.type,
      status: 'open',
      notes: input.notes,
      rev: 0,
    });
  }

  async patch(
    key: string,
    fields: Partial<Pick<TodoDoc, 'title' | 'type' | 'status' | 'notes'>>,
  ): Promise<void> {
    const doc = await this.find(key);
    await doc?.incrementalPatch(fields);
  }

  async setStatus(key: string, status: TodoStatus): Promise<void> {
    await this.patch(key, { status });
  }

  async remove(key: string): Promise<void> {
    const doc = await this.find(key);
    await doc?.remove();
  }

  private async find(key: string) {
    const db = await this.db;
    return db.todo.findOne(key).exec();
  }

  private async init(): Promise<TodoDatabase> {
    if (isDevMode()) {
      const { RxDBDevModePlugin } = await import('rxdb/plugins/dev-mode');
      addRxPlugin(RxDBDevModePlugin);
    }
    const db = await createRxDatabase<{ todo: TodoCollection }>({
      name: 'lifedb',
      storage: getRxStorageDexie(),
      multiInstance: true,
      ignoreDuplicate: isDevMode(),
    });
    await db.addCollections({ todo: { schema, conflictHandler } });
    this.startReplication(db.todo);
    return db;
  }

  private startReplication(collection: TodoCollection): void {
    const guardAuth = (res: Response) => {
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 401 || res.status === 403 || res.redirected || !ct.includes('application/json')) {
        this.syncError.set('login required — reopen the app to sign in');
        throw new Error('auth-required');
      }
    };

    const replication = replicateRxCollection<TodoDoc, { rev: number }>({
      collection,
      replicationIdentifier: 'todo-http-sync',
      live: true,
      retryTime: 5000,
      pull: {
        batchSize: 200,
        handler: async (checkpoint, batchSize) => {
          const since = checkpoint?.rev ?? 0;
          const res = await fetch(`/api/sync/todo?since=${since}&limit=${batchSize}`, {
            credentials: 'include',
          });
          guardAuth(res);
          if (!res.ok) throw new Error(`pull failed: ${res.status}`);
          const body = (await res.json()) as {
            documents: (TodoDoc & { _deleted: boolean })[];
            checkpoint: { rev: number };
          };
          this.syncError.set(null);
          return { documents: body.documents, checkpoint: body.checkpoint };
        },
      },
      push: {
        batchSize: 50,
        handler: async (rows) => {
          const res = await fetch('/api/sync/todo', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(rows),
          });
          guardAuth(res);
          if (!res.ok) throw new Error(`push failed: ${res.status}`);
          this.syncError.set(null);
          return (await res.json()) as (TodoDoc & { _deleted: boolean })[];
        },
      },
    });
    replication.error$.subscribe((err) => {
      if (this.syncError() === null) {
        console.warn('[todo sync]', err);
      }
    });
  }
}
