import { describe, expect, it, vi } from 'vitest';

import { FieldConflict, MergeTrace, makeConflictHandler } from './conflict-merge';
import { ShoppingDoc } from './shopping-store';

type MasterDoc = ShoppingDoc & { _deleted: boolean };

const FIELDS = ['name', 'quantity', 'unit', 'barcode', 'done'] as const;

const base: MasterDoc = {
  ulid: 'a',
  id: 1,
  name: 'Yoghurt',
  quantity: 1,
  unit: null,
  barcode: null,
  done: false,
  rev: 5,
  _deleted: false,
};

function setup() {
  const onConflicts = vi.fn<(kept: MasterDoc, conflicts: FieldConflict[]) => void>();
  const trace = vi.fn<(t: MergeTrace) => void>();
  const handler = makeConflictHandler<ShoppingDoc>({ fields: FIELDS, onConflicts, trace });
  const resolve = (real: MasterDoc, mine: MasterDoc, assumed: MasterDoc | undefined = base) =>
    handler.resolve({ realMasterState: real, newDocumentState: mine, assumedMasterState: assumed }, 'test');
  return { handler, resolve, onConflicts, trace };
}

describe('field-level 3-way merge', () => {
  it('non-overlapping edits from two devices BOTH survive', async () => {
    const { resolve, onConflicts } = setup();
    const real = { ...base, name: 'Greek yoghurt', rev: 6 }; // other device renamed
    const mine = { ...base, quantity: 2 }; // this device changed the quantity
    const merged = await resolve(real, mine);
    expect(merged.name).toBe('Greek yoghurt');
    expect(merged.quantity).toBe(2);
    expect(merged.rev).toBe(6); // server identity fields come from the master
    expect(onConflicts).not.toHaveBeenCalled();
  });

  it('a field I did not touch takes the server value', async () => {
    const { resolve } = setup();
    const real = { ...base, unit: 'kg', rev: 6 };
    const mine = { ...base }; // pushed a stale copy, no local change
    const merged = await resolve(real, mine);
    expect(merged.unit).toBe('kg');
  });

  it('same-field conflict: local wins, and the losing value is reported', async () => {
    const { resolve, onConflicts } = setup();
    const real = { ...base, name: 'Skyr', rev: 6 };
    const mine = { ...base, name: 'Kefir' };
    const merged = await resolve(real, mine);
    expect(merged.name).toBe('Kefir');
    expect(onConflicts).toHaveBeenCalledOnce();
    const [kept, conflicts] = onConflicts.mock.calls[0];
    expect(kept.name).toBe('Kefir');
    expect(conflicts).toEqual([{ field: 'name', mine: 'Kefir', theirs: 'Skyr' }]);
  });

  it('both devices making the SAME change is not a conflict', async () => {
    const { resolve, onConflicts } = setup();
    const real = { ...base, done: true, rev: 6 };
    const mine = { ...base, done: true };
    const merged = await resolve(real, mine);
    expect(merged.done).toBe(true);
    expect(onConflicts).not.toHaveBeenCalled();
  });

  it('a server tombstone stands — matching the set-only server invariant', async () => {
    const { resolve, onConflicts } = setup();
    const real = { ...base, _deleted: true, rev: 6 };
    const mine = { ...base, name: 'edited offline' };
    expect(await resolve(real, mine)).toBe(real);
    expect(onConflicts).not.toHaveBeenCalled();
  });

  it('a local delete stands even when the other device edited', async () => {
    const { resolve } = setup();
    const real = { ...base, name: 'renamed elsewhere', rev: 6 };
    const mine = { ...base, _deleted: true };
    const merged = await resolve(real, mine);
    expect(merged._deleted).toBe(true);
    expect(merged.name).toBe('renamed elsewhere'); // their edit still lands underneath
  });

  it('without an assumed base there is nothing to diff — latest intent wins', async () => {
    const { handler } = setup();
    const real = { ...base, name: 'server', rev: 6 };
    const mine = { ...base, name: 'local' };
    // No default-arg helper here: assumedMasterState must be genuinely absent.
    const merged = await handler.resolve(
      { realMasterState: real, newDocumentState: mine, assumedMasterState: undefined },
      'test',
    );
    expect(merged).toBe(mine);
  });

  it('traces the per-field merge outcome so the path is observable', async () => {
    const { resolve, trace } = setup();
    // Three fields move at once: I renamed + repriced; the other device set the
    // unit and ALSO renamed (a real collision on name).
    const real = { ...base, name: 'Skyr', unit: 'kg', rev: 6 };
    const mine = { ...base, name: 'Kefir', quantity: 4 };
    await resolve(real, mine);
    expect(trace).toHaveBeenCalledOnce();
    const t = trace.mock.calls[0][0];
    expect(t.ulid).toBe('a');
    expect(t.mine.sort()).toEqual(['name', 'quantity']); // fields I changed → mine
    expect(t.theirs).toEqual(['unit']); // field only they changed → survives
    expect(t.collided).toEqual(['name']); // both changed name → local won, logged
    expect(t.deleted).toBe(false);
    expect(t.noBase).toBe(false);
  });

  it('trace does not flag an untouched field as theirs', async () => {
    const { resolve, trace } = setup();
    // Only I changed anything; nothing of theirs moved off the base.
    await resolve({ ...base, rev: 6 }, { ...base, done: true });
    const t = trace.mock.calls[0][0];
    expect(t.mine).toEqual(['done']);
    expect(t.theirs).toEqual([]); // no remote change to pull in
    expect(t.collided).toEqual([]);
  });

  it('trace marks the no-base wholesale-local path', async () => {
    const { handler, trace } = setup();
    await handler.resolve(
      { realMasterState: { ...base, name: 'server', rev: 6 }, newDocumentState: { ...base, name: 'local' }, assumedMasterState: undefined },
      'test',
    );
    expect(trace.mock.calls[0][0]).toMatchObject({ ulid: 'a', noBase: true, mine: [], theirs: [] });
  });

  it('isEqual compares revision, deleted flag AND content fields', () => {
    const { handler } = setup();
    expect(handler.isEqual(base, { ...base }, 'test')).toBe(true);
    expect(handler.isEqual(base, { ...base, rev: 6 }, 'test')).toBe(false);
    expect(handler.isEqual(base, { ...base, _deleted: true }, 'test')).toBe(false);
    // THE push-loss regression: an edit changes content but not rev (revs are
    // server-minted). isEqual=true here told RxDB's upstream "already
    // replicated" and the edit was silently never pushed.
    expect(handler.isEqual(base, { ...base, name: 'Kefir' }, 'test')).toBe(false);
    expect(handler.isEqual(base, { ...base, quantity: 3 }, 'test')).toBe(false);
    // undefined and null are the same absence (wire sends null explicitly).
    expect(handler.isEqual({ ...base, unit: undefined as unknown as null }, { ...base, unit: null }, 'test')).toBe(true);
    // Two tombstones are equal regardless of content — nothing left to sync.
    expect(
      handler.isEqual({ ...base, _deleted: true }, { ...base, name: 'Old', _deleted: true }, 'test'),
    ).toBe(true);
  });
});
