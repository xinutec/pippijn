import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { TodoDoc, TodoStore } from '../../sync/todo-store';
import { Todo } from './todo';

const doc = (over: Partial<TodoDoc>): TodoDoc => ({
  ulid: 'u',
  id: null,
  title: 't',
  type: 'purchase',
  status: 'open',
  notes: null,
  rev: 0,
  ...over,
});

describe('Todo', () => {
  function setup(initial: TodoDoc[] = []) {
    const items$ = new BehaviorSubject<TodoDoc[]>(initial);
    const store = {
      items$,
      syncError: signal<string | null>(null),
      add: vi.fn(),
      patch: vi.fn(),
      setStatus: vi.fn(),
      remove: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [Todo],
      providers: [{ provide: TodoStore, useValue: store }],
    });
    return { fixture: TestBed.createComponent(Todo), store };
  }

  it('adds a typed to-do and clears the form', () => {
    const { fixture, store } = setup();
    const c = fixture.componentInstance;
    c.title.set('Call plumber');
    c.newType.set('call');
    c.notes.set('leaky tap');
    c.add();
    expect(store.add).toHaveBeenCalledWith({ title: 'Call plumber', type: 'call', notes: 'leaky tap' });
    expect(c.title()).toBe('');
    expect(c.notes()).toBe('');
  });

  it('ignores a blank title', () => {
    const { fixture, store } = setup();
    fixture.componentInstance.title.set('   ');
    fixture.componentInstance.add();
    expect(store.add).not.toHaveBeenCalled();
  });

  it('toggles status open ↔ done', () => {
    const { fixture, store } = setup();
    fixture.componentInstance.toggle(doc({ ulid: 'a', status: 'open' }));
    expect(store.setStatus).toHaveBeenCalledWith('a', 'done');
  });

  it('filters the visible list by type', () => {
    const { fixture } = setup([doc({ ulid: 'a', type: 'purchase' }), doc({ ulid: 'b', type: 'call' })]);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    expect(c.visible().length).toBe(2);
    c.filter.set('call');
    expect(c.visible().map((t) => t.ulid)).toEqual(['b']);
  });
});
