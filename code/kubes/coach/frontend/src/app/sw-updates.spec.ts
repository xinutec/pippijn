import { TestBed } from '@angular/core/testing';
import { SwUpdate, VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SwUpdates } from './sw-updates';

function setup(isEnabled: boolean) {
  const versionUpdates = new Subject<VersionEvent>();
  const checkForUpdate = vi.fn().mockResolvedValue(false);
  TestBed.configureTestingModule({
    providers: [SwUpdates, { provide: SwUpdate, useValue: { isEnabled, versionUpdates, checkForUpdate } }],
  });
  const svc = TestBed.inject(SwUpdates);
  const apply = vi.spyOn(svc, 'applyUpdate').mockImplementation(() => {});
  return { svc, versionUpdates, checkForUpdate, apply };
}

const ready = { type: 'VERSION_READY' } as VersionEvent;

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('SwUpdates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => vi.useRealTimers());

  it('checks at startup and reloads when a new version is ready right away', () => {
    const { svc, versionUpdates, checkForUpdate, apply } = setup(true);
    svc.start();
    expect(checkForUpdate).toHaveBeenCalledOnce();
    versionUpdates.next(ready);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('does nothing when the service worker is disabled (dev build)', () => {
    const { svc, versionUpdates, checkForUpdate, apply } = setup(false);
    svc.start();
    expect(checkForUpdate).not.toHaveBeenCalled();
    versionUpdates.next(ready);
    expect(apply).not.toHaveBeenCalled();
  });

  it('ignores version events other than VERSION_READY', () => {
    const { svc, versionUpdates, apply } = setup(true);
    svc.start();
    versionUpdates.next({ type: 'VERSION_DETECTED' } as VersionEvent);
    versionUpdates.next({ type: 'NO_NEW_VERSION_DETECTED' } as VersionEvent);
    expect(apply).not.toHaveBeenCalled();
  });

  it('re-checks for updates when the app becomes visible again (stale tab)', () => {
    const { svc, checkForUpdate } = setup(true);
    svc.start();
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    expect(checkForUpdate).toHaveBeenCalledTimes(1); // hiding does not check
    setVisibility('visible');
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('defers a mid-session update to the next backgrounding, not mid-use', () => {
    const { svc, versionUpdates, apply } = setup(true);
    svc.start();
    vi.advanceTimersByTime(60_000); // long past the startup window
    versionUpdates.next(ready);
    expect(apply).not.toHaveBeenCalled(); // user may be mid-edit
    setVisibility('hidden');
    expect(apply).toHaveBeenCalledOnce(); // reloads invisibly once backgrounded
  });

  it('applies a mid-session update immediately when the app is hidden', () => {
    const { svc, versionUpdates, apply } = setup(true);
    svc.start();
    vi.advanceTimersByTime(60_000);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    versionUpdates.next(ready);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('checkNow applies immediately — the user explicitly asked', async () => {
    const { svc, versionUpdates, checkForUpdate, apply } = setup(true);
    svc.start();
    vi.advanceTimersByTime(60_000);
    checkForUpdate.mockResolvedValueOnce(true);
    await expect(svc.checkNow()).resolves.toBe('updating');
    versionUpdates.next(ready);
    expect(apply).toHaveBeenCalledOnce(); // no deferral on a manual check
  });

  it('checkNow reports current when no update was found', async () => {
    const { svc } = setup(true);
    svc.start();
    await expect(svc.checkNow()).resolves.toBe('current');
  });
});
