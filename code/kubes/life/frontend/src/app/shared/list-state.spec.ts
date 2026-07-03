import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { ListState } from './list-state';

/** Render one state at a time and assert the DOM the list screens rely on. */
function render(inputs: Partial<Record<'loading' | 'error' | 'empty', boolean> & { emptyText: string; emptyIcon: string }>) {
  const fixture = TestBed.createComponent(ListState);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return fixture;
}

describe('ListState', () => {
  it('shows a progress bar while loading (and nothing else)', () => {
    const el = render({ loading: true, empty: true }).nativeElement as HTMLElement;
    expect(el.querySelector('mat-progress-bar')).toBeTruthy();
    expect(el.querySelector('.state')).toBeFalsy(); // loading wins over empty
  });

  it('shows the error state with a Retry button, and emits (retry) on click', () => {
    const fixture = render({ error: true });
    const el = fixture.nativeElement as HTMLElement;
    const box = el.querySelector('.state.error');
    expect(box).toBeTruthy();

    let retried = false;
    fixture.componentInstance.retry.subscribe(() => (retried = true));
    el.querySelector<HTMLButtonElement>('.state.error button')!.click();
    expect(retried).toBe(true);
  });

  it('shows the empty message with its icon', () => {
    const el = render({ empty: true, emptyText: 'No items yet.', emptyIcon: 'inventory_2' })
      .nativeElement as HTMLElement;
    const box = el.querySelector('.state.empty');
    expect(box?.textContent).toContain('No items yet.');
    expect(box?.querySelector('mat-icon')?.textContent).toContain('inventory_2');
  });

  it('renders nothing once loaded with content', () => {
    const el = render({}).nativeElement as HTMLElement;
    expect(el.querySelector('mat-progress-bar')).toBeFalsy();
    expect(el.querySelector('.state')).toBeFalsy();
  });
});
