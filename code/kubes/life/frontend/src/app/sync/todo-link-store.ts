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

import { LinkKind, TargetKind } from '../models';

/** A to-do connection stored locally. `from` is the source to-do's ulid; the
 *  target is a soft ref (`targetRef` interpreted per `targetKind`). Mirrors the
 *  backend `TodoLinkDoc`. */
export interface TodoLinkDoc {
  ulid: string;
  id: number | null;
  from: string;
  kind: LinkKind;
  targetKind: TargetKind;
  targetRef: string;
  rev: number;
}

type LinkCollection = RxCollection<TodoLinkDoc>;
type LinkDatabase = RxDatabase<{ todo_link: LinkCollection }>;

const schema: RxJsonSchema<TodoLinkDoc> = {
  version: 0,
  primaryKey: 'ulid',
  type: 'object',
  properties: {
    ulid: { type: 'string', maxLength: 26 },
    id: { type: ['integer', 'null'] },
    from: { type: 'string', maxLength: 26 },
    kind: { type: 'string', enum: ['depends_on', 'subtask', 'related'], maxLength: 16 },
    targetKind: {
      type: 'string',
      enum: ['todo', 'item', 'recipe', 'room', 'shopping', 'place'],
      maxLength: 16,
    },
    targetRef: { type: 'string', maxLength: 255 },
    rev: { type: 'number' },
  },
  required: ['ulid', 'from', 'kind', 'targetKind', 'targetRef', 'rev'],
};

const conflictHandler: RxConflictHandler<TodoLinkDoc> = {
  isEqual: (a, b) => a.rev === b.rev && !!a._deleted === !!b._deleted,
  resolve: ({ realMasterState, newDocumentState }) =>
    Promise.resolve(realMasterState._deleted ? realMasterState : newDocumentState),
};

/** Local-first store for the to-do connection edges, synced with
 *  /api/sync/todo-link. Reads are reactive + offline; writes are local. */
@Injectable({ providedIn: 'root' })
export class TodoLinkStore {
  readonly syncError = signal<string | null>(null);

  private readonly db = this.init();

  /** Live, non-deleted connection edges. */
  readonly links$: Observable<TodoLinkDoc[]> = from(this.db).pipe(
    switchMap((db) => db.todo_link.find().$),
    map((docs) => docs.map((d) => d.toJSON() as TodoLinkDoc)),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  async add(input: {
    from: string;
    kind: LinkKind;
    targetKind: TargetKind;
    targetRef: string;
  }): Promise<void> {
    const db = await this.db;
    // Skip an exact duplicate edge.
    const dup = await db.todo_link
      .findOne({
        selector: {
          from: input.from,
          kind: input.kind,
          targetKind: input.targetKind,
          targetRef: input.targetRef,
        },
      })
      .exec();
    if (dup) return;
    await db.todo_link.insert({ ulid: ulid(), id: null, rev: 0, ...input });
  }

  async remove(key: string): Promise<void> {
    const db = await this.db;
    const doc = await db.todo_link.findOne(key).exec();
    await doc?.remove();
  }

  /** Remove every edge touching a to-do (from OR target) — used when a to-do is
   *  deleted so it leaves no dangling connections. */
  async removeForTodo(todoUlid: string): Promise<void> {
    const db = await this.db;
    await db.todo_link
      .find({
        selector: {
          $or: [{ from: todoUlid }, { targetKind: 'todo', targetRef: todoUlid }],
        },
      })
      .remove();
  }

  private async init(): Promise<LinkDatabase> {
    if (isDevMode()) {
      const { RxDBDevModePlugin } = await import('rxdb/plugins/dev-mode');
      addRxPlugin(RxDBDevModePlugin);
    }
    const db = await createRxDatabase<{ todo_link: LinkCollection }>({
      name: 'lifedb',
      storage: getRxStorageDexie(),
      multiInstance: true,
      ignoreDuplicate: isDevMode(),
    });
    await db.addCollections({ todo_link: { schema, conflictHandler } });
    this.startReplication(db.todo_link);
    return db;
  }

  private startReplication(collection: LinkCollection): void {
    const guardAuth = (res: Response) => {
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 401 || res.status === 403 || res.redirected || !ct.includes('application/json')) {
        this.syncError.set('login required — reopen the app to sign in');
        throw new Error('auth-required');
      }
    };

    const replication = replicateRxCollection<TodoLinkDoc, { rev: number }>({
      collection,
      replicationIdentifier: 'todo-link-http-sync',
      live: true,
      retryTime: 5000,
      pull: {
        batchSize: 200,
        handler: async (checkpoint, batchSize) => {
          const since = checkpoint?.rev ?? 0;
          const res = await fetch(`/api/sync/todo-link?since=${since}&limit=${batchSize}`, {
            credentials: 'include',
          });
          guardAuth(res);
          if (!res.ok) throw new Error(`pull failed: ${res.status}`);
          const body = (await res.json()) as {
            documents: (TodoLinkDoc & { _deleted: boolean })[];
            checkpoint: { rev: number };
          };
          this.syncError.set(null);
          return { documents: body.documents, checkpoint: body.checkpoint };
        },
      },
      push: {
        batchSize: 50,
        handler: async (rows) => {
          const res = await fetch('/api/sync/todo-link', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(rows),
          });
          guardAuth(res);
          if (!res.ok) throw new Error(`push failed: ${res.status}`);
          this.syncError.set(null);
          return (await res.json()) as (TodoLinkDoc & { _deleted: boolean })[];
        },
      },
    });
    replication.error$.subscribe((err) => {
      if (this.syncError() === null) {
        console.warn('[todo-link sync]', err);
      }
    });
  }
}
