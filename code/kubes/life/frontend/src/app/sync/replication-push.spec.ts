import {
  createRxDatabase,
  type RxCollection,
  type RxJsonSchema,
  type RxReplicationWriteToMasterRow,
  type WithDeleted,
} from 'rxdb';
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

type PullHandler = () => Promise<{ documents: WithDeleted<Doc>[]; checkpoint: { rev: number } }>;
type PushHandler = (rows: RxReplicationWriteToMasterRow<Doc>[]) => Promise<WithDeleted<Doc>[]>;

async function setup(opts?: { pull?: PullHandler; push?: PushHandler }) {
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
  const defaultPush: PushHandler = (rows) => {
    pushed.push(...rows.map((r) => r.newDocumentState as Doc));
    return Promise.resolve([]); // no conflicts
  };
  const replication = replicateRxCollection<Doc, { rev: number }>({
    collection,
    replicationIdentifier: 'push-spec-sync',
    live: true,
    retryTime: 100,
    pull: {
      // Default: empty master — most tests here are about the upstream half.
      handler: opts?.pull ?? (() => Promise.resolve({ documents: [], checkpoint: { rev: 0 } })),
    },
    push: { handler: opts?.push ?? defaultPush },
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

  it('several docs edited before one sync ALL reach the push handler', async () => {
    // The multi-edit worry: a batch of independent local edits made while
    // offline must every one survive the flush — none silently dropped.
    const { db, collection, replication, pushed } = await setup();
    const ids = ['u1', 'u2', 'u3'];
    await collection.bulkInsert(
      ids.map((ulid) => ({ ulid, recordedAt: '2026-07-03T00:00:00.000Z', score: 1, note: null, rev: 0 })),
    );
    await replication.awaitInSync();
    pushed.length = 0; // ignore the insert pushes; watch only the edits

    for (const id of ids) {
      const d = await collection.findOne(id).exec();
      await d!.incrementalPatch({ score: 9 });
    }
    await replication.awaitInSync();

    await vi.waitFor(() => {
      const byId = new Map(pushed.map((p) => [p.ulid, p]));
      expect([...byId.keys()].sort()).toEqual(ids);
      for (const id of ids) expect(byId.get(id)!.score).toBe(9);
    });
    await db.close();
  });

  it('a server-rejected edit is re-resolved and re-pushed — both devices’ fields survive', async () => {
    // The -v2 heal / concurrent-edit path: the server rejects a stale-rev push,
    // returns its current row as a conflict, RxDB runs our conflict handler's
    // 3-way merge, and re-pushes the result. This device changed `score`; the
    // OTHER device changed `note`. Neither edit may be lost.
    const server = new Map<string, WithDeleted<Doc>>();
    server.set('u1', {
      ulid: 'u1',
      recordedAt: '2026-07-01T00:00:00.000Z',
      score: 1,
      note: null,
      rev: 1,
      _deleted: false,
    });
    let seeded = false;
    let pushRounds = 0;

    const { db, collection, replication } = await setup({
      // Seed the client with the server's rev-1 row exactly once, so the later
      // local edit carries a real assumedMasterState (not the no-base shortcut).
      pull: () => {
        if (seeded) return Promise.resolve({ documents: [], checkpoint: { rev: 1 } });
        seeded = true;
        return Promise.resolve({ documents: [server.get('u1')!], checkpoint: { rev: 1 } });
      },
      // Optimistic-concurrency server: reject when the client's assumed rev is
      // stale, handing back the current row for the client to resolve against.
      push: (rows) => {
        pushRounds++;
        const conflicts: WithDeleted<Doc>[] = [];
        for (const r of rows) {
          const mine = r.newDocumentState as Doc;
          const assumed = r.assumedMasterState as Doc | undefined;
          const cur = server.get(mine.ulid);
          if (cur && cur.rev !== assumed?.rev) {
            conflicts.push(cur);
          } else {
            const next: WithDeleted<Doc> = { ...mine, rev: (cur?.rev ?? 0) + 1, _deleted: false };
            server.set(mine.ulid, next);
          }
        }
        return Promise.resolve(conflicts);
      },
    });

    await vi.waitFor(() => expect(seeded).toBe(true));
    await replication.awaitInSync();

    // The other device sets a note → rev 2, while this device edits the score.
    server.set('u1', { ...server.get('u1')!, note: 'from other device', rev: 2 });
    const doc = await collection.findOne('u1').exec();
    await doc!.incrementalPatch({ score: 5 });
    await replication.awaitInSync();

    await vi.waitFor(() => {
      const cur = server.get('u1')!;
      expect(cur.score).toBe(5); // my edit landed
      expect(cur.note).toBe('from other device'); // their edit was NOT clobbered
    });
    expect(pushRounds).toBeGreaterThanOrEqual(2); // a conflict round, then an accept
    await db.close();
  });
});
