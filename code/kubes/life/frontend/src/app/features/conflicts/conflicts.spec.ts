import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { LifeApi } from '../../life-api';
import { ConflictEntry } from '../../models';
import { ShoppingStore } from '../../sync/shopping-store';
import { TodoStore } from '../../sync/todo-store';
import { WellbeingStore } from '../../sync/wellbeing-store';
import { Conflicts } from './conflicts';

const ENTRIES: ConflictEntry[] = [
  {
    id: 1,
    kind: 'todo',
    ulid: '01HXAMPLETODOULID000000000',
    field: 'notes',
    label: 'Call the GP',
    mine: '"ask about MRI"',
    theirs: '"ask about bloods"',
    created_at: 1751400000000,
  },
];

function mount() {
  const api = {
    conflicts: vi.fn(() => of(ENTRIES)),
    resolveConflict: vi.fn(() => of(undefined)),
  };
  const shopping = { patch: vi.fn(() => Promise.resolve()) };
  const todo = { patch: vi.fn(() => Promise.resolve()) };
  const wellbeing = { patch: vi.fn(() => Promise.resolve()) };
  TestBed.configureTestingModule({
    imports: [Conflicts],
    providers: [
      { provide: LifeApi, useValue: api },
      { provide: ShoppingStore, useValue: shopping },
      { provide: TodoStore, useValue: todo },
      { provide: WellbeingStore, useValue: wellbeing },
    ],
  });
  const fixture = TestBed.createComponent(Conflicts);
  fixture.autoDetectChanges();
  return { fixture, api, shopping, todo };
}

describe('Conflicts', () => {
  it('lists both values so nothing reads as silently lost', async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Call the GP');
    expect(text).toContain('ask about MRI');
    expect(text).toContain('ask about bloods');
  });

  it('keep-mine only clears the log entry', async () => {
    const { fixture, api, todo } = mount();
    await fixture.whenStable();
    fixture.componentInstance.keepMine(ENTRIES[0]);
    await fixture.whenStable();
    expect(todo.patch).not.toHaveBeenCalled();
    expect(api.resolveConflict).toHaveBeenCalledWith(1);
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Call the GP');
  });

  it('use-other patches the live row, then clears the entry', async () => {
    const { fixture, api, todo } = mount();
    await fixture.whenStable();
    fixture.componentInstance.useTheirs(ENTRIES[0]);
    await fixture.whenStable();
    expect(todo.patch).toHaveBeenCalledWith('01HXAMPLETODOULID000000000', {
      notes: 'ask about bloods',
    });
    expect(api.resolveConflict).toHaveBeenCalledWith(1);
  });
});
