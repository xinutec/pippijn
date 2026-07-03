import { TestBed } from '@angular/core/testing';
import { MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { describe, expect, it, vi } from 'vitest';

import { Feedback } from '../../shared/feedback';
import { TodoStore } from '../../sync/todo-store';
import { TodoAddSheet } from './todo-add-sheet';

describe('TodoAddSheet', () => {
  function setup() {
    const store = { add: vi.fn().mockResolvedValue('new-ulid') };
    const ref = { dismiss: vi.fn() };
    TestBed.configureTestingModule({
      imports: [TodoAddSheet],
      providers: [
        { provide: TodoStore, useValue: store },
        { provide: MatBottomSheetRef, useValue: ref },
        { provide: Feedback, useValue: { notify: vi.fn() } },
      ],
    });
    return { fixture: TestBed.createComponent(TodoAddSheet), store, ref };
  }

  it('adds a typed to-do, clears the form, and stays open', () => {
    const { fixture, store, ref } = setup();
    const c = fixture.componentInstance;
    c.title.set('Call plumber');
    c.type.set('call');
    c.notes.set('leaky tap');
    c.add();
    expect(store.add).toHaveBeenCalledWith({
      title: 'Call plumber',
      type: 'call',
      priority: null,
      notes: 'leaky tap',
      due: null,
    });
    expect(c.title()).toBe('');
    expect(c.notes()).toBe('');
    expect(ref.dismiss).not.toHaveBeenCalled(); // burst entry: sheet stays open
  });

  it('ignores a blank title', () => {
    const { fixture, store } = setup();
    fixture.componentInstance.title.set('   ');
    fixture.componentInstance.add();
    expect(store.add).not.toHaveBeenCalled();
  });
});
