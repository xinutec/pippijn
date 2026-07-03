import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { LifeApi } from '../../life-api';
import { TrashEntry } from '../../models';
import { ShoppingStore } from '../../sync/shopping-store';
import { TodoStore } from '../../sync/todo-store';
import { WellbeingStore } from '../../sync/wellbeing-store';
import { Trash } from './trash';

const ENTRIES: TrashEntry[] = [
  { kind: 'item', ref: '7', name: 'Old jar', deleted_at: 1751400000000 },
  { kind: 'shopping', ref: '01HXAMPLE', name: 'Milk', deleted_at: 1751300000000 },
];

function mount(api: Partial<Record<'trash' | 'restoreTrash', unknown>> = {}) {
  const apiMock = {
    trash: vi.fn(() => of(ENTRIES)),
    restoreTrash: vi.fn(() => of(undefined)),
    ...api,
  };
  const shopping = { reSync: vi.fn() };
  const todo = { reSync: vi.fn() };
  const wellbeing = { reSync: vi.fn() };
  TestBed.configureTestingModule({
    imports: [Trash],
    providers: [
      { provide: LifeApi, useValue: apiMock },
      { provide: ShoppingStore, useValue: shopping },
      { provide: TodoStore, useValue: todo },
      { provide: WellbeingStore, useValue: wellbeing },
    ],
  });
  const fixture = TestBed.createComponent(Trash);
  fixture.autoDetectChanges();
  return { fixture, api: apiMock, shopping, todo };
}

describe('Trash', () => {
  it('shows a loading bar, not a false "empty" message, before the trash arrives', async () => {
    const pending = new Subject<TrashEntry[]>();
    const { fixture } = mount({ trash: vi.fn(() => pending.asObservable()) });
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('mat-progress-bar')).toBeTruthy();
    expect(el.textContent).not.toContain('Nothing here');
  });

  it('lists deleted things with their kind', async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Old jar');
    expect(text).toContain('Milk');
    expect(text).toContain('Item');
    expect(text).toContain('Buy');
  });

  it('restore calls the API, drops the row, and re-syncs the owning store', async () => {
    const { fixture, api, shopping } = mount();
    await fixture.whenStable();
    fixture.componentInstance.restore(ENTRIES[1]);
    await fixture.whenStable();
    expect(api.restoreTrash).toHaveBeenCalledWith('shopping', '01HXAMPLE');
    expect(shopping.reSync).toHaveBeenCalledOnce();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Milk');
    expect(text).toContain('Old jar');
  });
});
