import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { LifeApi } from '../../life-api';
import { ShoppingStore } from '../../sync/shopping-store';
import { TodoLinkDoc, TodoLinkStore } from '../../sync/todo-link-store';
import { TodoDoc, TodoStore } from '../../sync/todo-store';
import { TodoGraph } from './todo-graph';

const todo = (over: Partial<TodoDoc>): TodoDoc => ({
  ulid: 'u',
  id: null,
  title: 't',
  type: 'purchase',
  status: 'open',
  priority: null,
  notes: null,
  rev: 0,
  ...over,
});

const link = (over: Partial<TodoLinkDoc>): TodoLinkDoc => ({
  ulid: 'l',
  id: null,
  from: 'a',
  kind: 'related',
  targetKind: 'todo',
  targetRef: 'b',
  rev: 0,
  ...over,
});

function make(todos: TodoDoc[], links: TodoLinkDoc[]): TodoGraph {
  TestBed.configureTestingModule({
    providers: [
      TodoGraph,
      { provide: TodoStore, useValue: { items$: new BehaviorSubject(todos) } },
      { provide: TodoLinkStore, useValue: { links$: new BehaviorSubject(links) } },
      { provide: ShoppingStore, useValue: { items$: of([]) } },
      {
        provide: LifeApi,
        useValue: {
          items: () => of([]),
          recipes: () => of([]),
          locations: () => of([]),
          house: () => of({ rooms: [] }),
        },
      },
    ],
  });
  return TestBed.inject(TodoGraph);
}

describe('TodoGraph — ready/blocked derivation', () => {
  it('a to-do that depends on an open to-do is blocked', () => {
    const g = make(
      [todo({ ulid: 'a' }), todo({ ulid: 'b', status: 'open' })],
      [link({ from: 'a', kind: 'depends_on', targetKind: 'todo', targetRef: 'b' })],
    );
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('blocked');
    expect(g.blockers('a').map((t) => t.ulid)).toEqual(['b']);
  });

  it('becomes ready once the dependency is done', () => {
    const g = make(
      [todo({ ulid: 'a' }), todo({ ulid: 'b', status: 'done' })],
      [link({ from: 'a', kind: 'depends_on', targetKind: 'todo', targetRef: 'b' })],
    );
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('ready');
    expect(g.blockers('a')).toEqual([]);
  });

  it('a to-do with no dependencies is just open', () => {
    const g = make([todo({ ulid: 'a' })], []);
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('open');
  });

  it('resolves a link target to its catalog label', () => {
    const g = make([todo({ ulid: 'a', title: 'Buy milk' })], []);
    expect(g.resolve('todo', 'a').label).toBe('Buy milk');
    expect(g.search('milk').map((t) => t.ref)).toContain('a');
  });
});
