import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { MatSnackBar } from '@angular/material/snack-bar';
import { BehaviorSubject, Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { LifeApi } from '../../life-api';
import { TodoDoc, TodoStore } from '../../sync/todo-store';
import { Todo } from './todo';
import { TodoGraph } from './todo-graph';

const doc = (over: Partial<TodoDoc>): TodoDoc => ({
  ulid: 'u',
  id: null,
  title: 't',
  type: 'purchase',
  status: 'open',
  priority: null,
  notes: null,
  notBefore: null,
  due: null,
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
      revive: vi.fn(),
      reSync: vi.fn(),
    };
    const graph = {
      statusOf: vi.fn(() => 'open'),
      urgencyOf: vi.fn(() => 'none'),
      blockers: vi.fn(() => []),
      linkCount: vi.fn(() => 0),
      removeLinksForTodo: vi.fn(),
      refreshCatalogs: vi.fn(),
    };
    const api = { restoreTrash: vi.fn(() => of(undefined)) };
    const sheet = { open: vi.fn() };
    // Controllable snackbar: fire onAction / afterDismissed by hand.
    const action$ = new Subject<void>();
    const dismissed$ = new Subject<void>();
    const snack = {
      open: vi.fn(() => ({
        onAction: () => action$,
        afterDismissed: () => dismissed$,
      })),
    };
    TestBed.configureTestingModule({
      imports: [Todo],
      providers: [
        { provide: TodoStore, useValue: store },
        { provide: TodoGraph, useValue: graph },
        { provide: LifeApi, useValue: api },
        { provide: MatSnackBar, useValue: snack },
      ],
    });
    // Todo imports MatBottomSheetModule, which re-provides MatBottomSheet at the
    // component injector — overrideProvider forces our stub everywhere.
    TestBed.overrideProvider(MatBottomSheet, { useValue: sheet });
    return { fixture: TestBed.createComponent(Todo), store, graph, sheet, action$, dismissed$ };
  }

  it('toggles status open ↔ done', () => {
    const { fixture, store } = setup();
    fixture.componentInstance.toggle(doc({ ulid: 'a', status: 'open' }));
    expect(store.setStatus).toHaveBeenCalledWith('a', 'done');
  });

  it('refuses to complete a blocked to-do, but lets a done one be un-completed', () => {
    const { fixture, store, graph } = setup();
    graph.statusOf.mockReturnValue('blocked');
    fixture.componentInstance.toggle(doc({ ulid: 'a', status: 'open' }));
    expect(store.setStatus).not.toHaveBeenCalled(); // blocked → no-op
    // A done item is never "blocked"; un-completing always works.
    fixture.componentInstance.toggle(doc({ ulid: 'a', status: 'done' }));
    expect(store.setStatus).toHaveBeenCalledWith('a', 'open');
  });

  it('opens the detail sheet on a to-do', () => {
    const { fixture, sheet } = setup();
    fixture.componentInstance.openDetail(doc({ ulid: 'a' }));
    expect(sheet.open).toHaveBeenCalled();
  });

  it('deletes the to-do now but defers link removal until the undo window closes', () => {
    const { fixture, store, graph, dismissed$ } = setup();
    fixture.componentInstance.remove(doc({ ulid: 'a' }));
    expect(store.remove).toHaveBeenCalledWith('a');
    // Links are NOT removed yet — an undo must be able to bring them back.
    expect(graph.removeLinksForTodo).not.toHaveBeenCalled();
    dismissed$.next(); // snackbar closed with no undo
    expect(graph.removeLinksForTodo).toHaveBeenCalledWith('a');
  });

  it('undo revives the to-do and keeps its links (never removes them)', () => {
    const { fixture, store, graph, action$, dismissed$ } = setup();
    fixture.componentInstance.remove(doc({ ulid: 'a', id: 5 }));
    action$.next(); // user hit Undo
    expect(store.revive).toHaveBeenCalled();
    dismissed$.next(); // snackbar then closes — links must STILL not be removed
    expect(graph.removeLinksForTodo).not.toHaveBeenCalled();
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
