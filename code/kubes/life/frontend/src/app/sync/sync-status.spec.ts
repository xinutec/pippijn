import { describe, expect, it } from 'vitest';

import { SyncStatus } from './sync-status';

/** Flip the whole-app online state the way the browser does — SyncStatus keys
 *  off the window online/offline events, not a settable navigator.onLine. */
function goOffline() {
  window.dispatchEvent(new Event('offline'));
}
function goOnline() {
  window.dispatchEvent(new Event('online'));
}

describe('SyncStatus — persistent sync-health signal', () => {
  it('is synced when online with no reported errors', () => {
    goOnline();
    const s = new SyncStatus();
    expect(s.health()).toBe('synced');
    expect(s.message()).toBe('All changes synced.');
  });

  it('goes to error, surfacing the reported message, and recovers on clear', () => {
    goOnline();
    const s = new SyncStatus();
    s.reportError('todo sync', 'Server unreachable.');
    expect(s.health()).toBe('error');
    expect(s.message()).toBe('Server unreachable.');
    s.clearError('todo sync');
    expect(s.health()).toBe('synced');
  });

  it('offline outranks an error — a failed fetch while offline is not a fault', () => {
    goOnline();
    const s = new SyncStatus();
    s.reportError('todo sync', 'Server unreachable.');
    goOffline();
    expect(s.health()).toBe('offline');
    expect(s.message()).toContain('Offline');
    // Back online with the error still standing → the error is shown again.
    goOnline();
    expect(s.health()).toBe('error');
    expect(s.message()).toBe('Server unreachable.');
  });

  it('stays unhealthy until EVERY source has cleared', () => {
    goOnline();
    const s = new SyncStatus();
    s.reportError('todo sync', 'todo failed');
    s.reportError('shopping sync', 'shopping failed');
    s.clearError('todo sync');
    expect(s.health()).toBe('error'); // shopping still failing
    s.clearError('shopping sync');
    expect(s.health()).toBe('synced');
  });
});
