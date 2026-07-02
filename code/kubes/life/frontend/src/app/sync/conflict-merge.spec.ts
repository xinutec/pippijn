import { describe, expect, it, vi } from 'vitest';

import { FieldConflict, makeConflictHandler } from './conflict-merge';
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
  const handler = makeConflictHandler<ShoppingDoc>({ fields: FIELDS, onConflicts });
  const resolve = (real: MasterDoc, mine: MasterDoc, assumed: MasterDoc | undefined = base) =>
    handler.resolve({ realMasterState: real, newDocumentState: mine, assumedMasterState: assumed }, 'test');
  return { handler, resolve, onConflicts };
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

  it('isEqual compares revision + deleted flag', () => {
    const { handler } = setup();
    expect(handler.isEqual(base, { ...base }, 'test')).toBe(true);
    expect(handler.isEqual(base, { ...base, rev: 6 }, 'test')).toBe(false);
    expect(handler.isEqual(base, { ...base, _deleted: true }, 'test')).toBe(false);
  });
});
