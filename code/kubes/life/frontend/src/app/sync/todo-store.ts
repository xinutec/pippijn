import { Injectable, inject, signal } from '@angular/core';
import { Observable, from } from 'rxjs';
import { map, shareReplay, switchMap } from 'rxjs/operators';
import { ulid } from 'ulid';
import { type RxCollection, type RxJsonSchema } from 'rxdb';

import { TodoPriority, TodoStatus, TodoType } from '../models';
import { ConflictReporter, makeConflictHandler } from './conflict-merge';
import { LifeDb } from './life-db';
import { startHttpReplication } from './replication';
import { SyncStatus } from './sync-status';

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
  priority: TodoPriority | null;
  notes: string | null;
  /** Start-gate (YYYY-MM-DD): can't act before this day → "waiting". */
  notBefore: string | null;
  /** Deadline (YYYY-MM-DD): drives urgency ordering. */
  due: string | null;
  rev: number;
}

type TodoCollection = RxCollection<TodoDoc>;

const schema: RxJsonSchema<TodoDoc> = {
  // Bump the version + add a migration on ANY schema change, else existing local
  // DBs hit a hash mismatch. v1: `type` enum widened. v2: `priority` added.
  // v3: `notBefore` + `due` timing added.
  version: 3,
  primaryKey: 'ulid',
  type: 'object',
  properties: {
    ulid: { type: 'string', maxLength: 26 },
    id: { type: ['integer', 'null'] },
    title: { type: 'string' },
    type: {
      type: 'string',
      enum: ['purchase', 'call', 'appointment', 'admin', 'task'],
      maxLength: 16,
    },
    status: { type: 'string', enum: ['open', 'done'], maxLength: 8 },
    priority: { type: ['string', 'null'], maxLength: 8 },
    notes: { type: ['string', 'null'] },
    notBefore: { type: ['string', 'null'], maxLength: 10 },
    due: { type: ['string', 'null'], maxLength: 10 },
    rev: { type: 'number' },
  },
  required: ['ulid', 'title', 'type', 'status', 'rev'],
};

/** The content fields the 3-way merge diffs (see [[makeConflictHandler]]) —
 *  also the allowlist the Conflicts screen may patch on "use other". */
export const TODO_MERGE_FIELDS = [
  'title',
  'type',
  'status',
  'priority',
  'notes',
  'notBefore',
  'due',
] as const;

/** Local-first store for the to-do list: the on-device RxDB collection is the
 *  source of truth; replication reconciles with /api/sync/todo in the background.
 *  Reads are reactive and offline; writes are local + optimistic. */
@Injectable({ providedIn: 'root' })
export class TodoStore {
  /** null = ok; a string = a sync problem to surface (e.g. login required). */
  readonly syncError = signal<string | null>(null);

  private lifeDb = inject(LifeDb);
  private reporter = inject(ConflictReporter);
  private syncStatus = inject(SyncStatus);
  private readonly collection = this.init();
  private replication?: ReturnType<typeof startHttpReplication<TodoDoc>>;

  /** Live, sorted, non-deleted to-dos: open before done, then by title. */
  readonly items$: Observable<TodoDoc[]> = from(this.collection).pipe(
    switchMap((col) => col.find({ sort: [{ status: 'desc' }, { title: 'asc' }] }).$),
    map((docs) => docs.map((d) => d.toJSON() as TodoDoc)),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  async add(input: {
    title: string;
    type: TodoType;
    priority: TodoPriority | null;
    notes: string | null;
    notBefore?: string | null;
    due?: string | null;
  }): Promise<void> {
    const col = await this.collection;
    await col.insert({
      ulid: ulid(),
      id: null,
      title: input.title,
      type: input.type,
      status: 'open',
      priority: input.priority,
      notes: input.notes,
      notBefore: input.notBefore ?? null,
      due: input.due ?? null,
      rev: 0,
    });
  }

  async patch(
    key: string,
    fields: Partial<
      Pick<TodoDoc, 'title' | 'type' | 'status' | 'priority' | 'notes' | 'notBefore' | 'due'>
    >,
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

  /** Bring a just-removed doc back locally under the same ulid (insert after
   *  remove revives the RxDB tombstone). Works offline — the Undo snackbar's
   *  first layer; the server-side trash restore is the authoritative second. */
  async revive(doc: TodoDoc): Promise<void> {
    const col = await this.collection;
    await col.insert({ ...doc });
  }

  /** Ask replication to pull now — e.g. right after a server-side trash restore,
   *  so the resurrected row appears without waiting for the next natural sync. */
  reSync(): void {
    this.replication?.reSync();
  }

  private async find(key: string) {
    const col = await this.collection;
    return col.findOne(key).exec();
  }

  private async init(): Promise<TodoCollection> {
    // Field-level 3-way merge: concurrent edits to different fields both
    // survive; same-field collisions keep this device's value and land in the
    // server-side conflict log for review.
    const handler = makeConflictHandler<TodoDoc>({
      fields: TODO_MERGE_FIELDS,
      onConflicts: (kept, conflicts) =>
        this.reporter.report('todo', kept.ulid, kept.title, conflicts),
    });
    const col = await this.lifeDb.collection('todo', schema, handler, {
      1: (doc: Record<string, unknown>) => doc, // enum widened; existing docs already valid
      2: (doc: Record<string, unknown>) => ({ ...doc, priority: doc['priority'] ?? null }), // add priority field
      3: (doc: Record<string, unknown>) => ({
        ...doc,
        notBefore: doc['notBefore'] ?? null,
        due: doc['due'] ?? null,
      }), // add timing fields
    });
    this.startReplication(col);
    return col;
  }

  private startReplication(collection: TodoCollection): void {
    this.replication = startHttpReplication<TodoDoc>({
      collection,
      // '-v2': replication-state reset after the isEqual push-loss bug — see
      // the comment in wellbeing-store.ts.
      identifier: 'todo-http-sync-v2',
      path: '/api/sync/todo',
      syncError: this.syncError,
      syncStatus: this.syncStatus,
      label: 'todo sync',
    });
  }
}
