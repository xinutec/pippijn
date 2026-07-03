import { createRxDatabase, type RxCollection, type RxJsonSchema } from 'rxdb';
import { replicateRxCollection } from 'rxdb/plugins/replication';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { describe, expect, it, vi } from 'vitest';

import { makeConflictHandler } from './conflict-merge';

/** REGRESSION — silent push-loss (found 2026-07-03, via a wellbeing date edit
 *  that "saved" on the phone but never reached the server).
 *
 *  RxDB's replication upstream asks the collection's conflict handler
 *  `isEqual(assumedMaster, current, 'upstream-check-if-equal')` to decide
 *  whether a local doc still needs pushing — `false` is what queues the push.
 *  Our handler compared only `rev` + `_deleted`, and a local edit changes
 *  NEITHER (revs are server-minted), so every field edit was judged "already
 *  replicated" and dropped without a trace: no push, no error, nothing in the
 *  server log. Inserts (no assumed master) and deletes (`_deleted` flips)
 *  still synced, which made sync look healthy.
 *
 *  Unit tests on the handler can't catch a wrong *contract*, so this spec
 *  drives the REAL replication protocol (memory storage, live replication,
 *  our real handler) and asserts the only thing that matters: an
 *  `incrementalPatch` of a content field must reach the push handler. */

interface Doc {
  ulid: string;
  recordedAt: string;
  score: number;
  note: string | null;
  rev: number;
}

const schema: RxJsonSchema<Doc> = {
  version: 0,
  primaryKey: 'ulid',
  type: 'object',
  properties: {
    ulid: { type: 'string', maxLength: 26 },
    recordedAt: { type: 'string', maxLength: 32 },
    score: { type: 'number' },
    note: { type: ['string', 'null'] },
    rev: { type: 'number' },
  },
  required: ['ulid', 'recordedAt', 'score', 'rev'],
};

let seq = 0;

async function setup() {
  // Throwaway in-memory DB per test — this spec drives the raw replication
  // protocol, deliberately outside the app's shared-LifeDb plumbing.
  // ast-grep-ignore: life-single-rxdb
  const db = await createRxDatabase({
    name: `push-spec-${++seq}`,
    storage: getRxStorageMemory(),
    multiInstance: false,
  });
  const added = await db.addCollections({
    entries: { schema, conflictHandler: makeConflictHandler<Doc>({ fields: ['recordedAt', 'score', 'note'] }) },
  });
  const collection = added.entries as RxCollection<Doc>;
  const pushed: Doc[] = [];
  const replication = replicateRxCollection<Doc, { rev: number }>({
    collection,
    replicationIdentifier: 'push-spec-sync',
    live: true,
    retryTime: 100,
    pull: {
      // Empty master — this spec is about the upstream half.
      handler: () => Promise.resolve({ documents: [], checkpoint: { rev: 0 } }),
    },
    push: {
      handler: (rows) => {
        pushed.push(...rows.map((r) => r.newDocumentState as Doc));
        return Promise.resolve([]); // no conflicts
      },
    },
  });
  await replication.awaitInitialReplication();
  return { db, collection, replication, pushed };
}

describe('replication upstream — local writes actually push', () => {
  it('an insert is pushed', async () => {
    const { db, collection, replication, pushed } = await setup();
    await collection.insert({ ulid: 'u1', recordedAt: '2026-07-03T12:00:00.000Z', score: 4, note: null, rev: 0 });
    await replication.awaitInSync();
    expect(pushed.map((d) => d.ulid)).toEqual(['u1']);
    await db.close();
  });

  it('a field edit on a synced doc is pushed — THE push-loss regression', async () => {
    const { db, collection, replication, pushed } = await setup();
    await collection.insert({ ulid: 'u1', recordedAt: '2026-07-03T12:00:00.000Z', score: 4, note: null, rev: 0 });
    await replication.awaitInSync();

    // The bug: this patch changes content but not `rev` (server-minted), and a
    // rev-only isEqual judged it "already replicated" — saved locally, never sent.
    const doc = await collection.findOne('u1').exec();
    await doc!.incrementalPatch({ recordedAt: '2026-06-28T08:00:00.000Z' });

    await replication.awaitInSync();
    await vi.waitFor(() => expect(pushed).toHaveLength(2));
    expect(pushed[1]).toMatchObject({ ulid: 'u1', recordedAt: '2026-06-28T08:00:00.000Z' });
    await db.close();
  });

  it('a delete is pushed', async () => {
    const { db, collection, replication, pushed } = await setup();
    await collection.insert({ ulid: 'u1', recordedAt: '2026-07-03T12:00:00.000Z', score: 4, note: null, rev: 0 });
    await replication.awaitInSync();
    const doc = await collection.findOne('u1').exec();
    await doc!.remove();
    await replication.awaitInSync();
    await vi.waitFor(() => expect(pushed).toHaveLength(2));
    await db.close();
  });
});
