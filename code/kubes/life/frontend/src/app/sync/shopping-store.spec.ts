import { describe, expect, it } from 'vitest';

import { conflictHandler, ShoppingDoc } from './shopping-store';

type MasterDoc = ShoppingDoc & { _deleted: boolean };

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

// RxDB passes more fields; the handler only reads these.
function resolve(realMasterState: MasterDoc, newDocumentState: MasterDoc) {
  return conflictHandler.resolve(
    { realMasterState, newDocumentState, assumedMasterState: realMasterState } as never,
    'test',
  );
}

describe('shopping conflict handler', () => {
  it('keeps a delete sticky — a server tombstone is not resurrected by a local edit', async () => {
    const master = { ...base, _deleted: true };
    const local = { ...base, _deleted: false, name: 'edited offline' };
    expect(await resolve(master, local)).toBe(master);
  });

  it('otherwise the local edit (latest intent) wins', async () => {
    const master = { ...base, name: 'server name' };
    const local = { ...base, name: 'local name' };
    expect(await resolve(master, local)).toBe(local);
  });

  it('isEqual compares revision + deleted flag', () => {
    expect(conflictHandler.isEqual(base, { ...base }, 'test')).toBe(true);
    expect(conflictHandler.isEqual(base, { ...base, rev: 6 }, 'test')).toBe(false);
    expect(conflictHandler.isEqual(base, { ...base, _deleted: true }, 'test')).toBe(false);
  });
});
