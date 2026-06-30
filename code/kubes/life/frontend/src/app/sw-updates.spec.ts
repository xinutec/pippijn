import { TestBed } from '@angular/core/testing';
import { SwUpdate, VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

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

describe('SwUpdates', () => {
  it('checks at startup and reloads when a new version is ready', () => {
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
});
