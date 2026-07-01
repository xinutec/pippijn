import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { BUILD_INFO } from '../../build-info';
import { SwUpdates } from '../../sw-updates';
import { Settings } from './settings';

async function mount(checkNow = vi.fn(() => Promise.resolve('current' as const))) {
  TestBed.configureTestingModule({
    imports: [Settings],
    providers: [{ provide: SwUpdates, useValue: { checkNow } }],
  });
  const fixture = TestBed.createComponent(Settings);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  return { fixture, checkNow };
}

describe('Settings', () => {
  it('shows the stamped build version', async () => {
    const { fixture } = await mount();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Version');
    expect(text).toContain(BUILD_INFO.sha);
  });

  it('checks for updates via the service worker when the button is clicked', async () => {
    const { fixture, checkNow } = await mount();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button');
    button!.click();
    await fixture.whenStable();
    expect(checkNow).toHaveBeenCalledOnce();
  });
});
