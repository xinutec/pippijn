import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { LifeApi } from '../../life-api';
import { ShoppingDoc, ShoppingStore } from '../../sync/shopping-store';
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
  notBefore: null,
  due: null,
  rev: 0,
  ...over,
});

/** ISO date `n` days from today (device-local), for timing tests. */
const isoOffset = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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

const shop = (over: Partial<ShoppingDoc>): ShoppingDoc => ({
  ulid: 's',
  id: null,
  name: 'Milk',
  quantity: null,
  unit: null,
  barcode: null,
  done: false,
  rev: 0,
  ...over,
});

function make(todos: TodoDoc[], links: TodoLinkDoc[], shopping: ShoppingDoc[] = []) {
  const items = vi.fn(() => of([]));
  TestBed.configureTestingModule({
    providers: [
      TodoGraph,
      { provide: TodoStore, useValue: { items$: new BehaviorSubject(todos) } },
      { provide: TodoLinkStore, useValue: { links$: new BehaviorSubject(links) } },
      { provide: ShoppingStore, useValue: { items$: of(shopping) } },
      {
        provide: LifeApi,
        useValue: {
          items,
          recipes: () => of([]),
          locations: () => of([]),
          house: () => of({ rooms: [] }),
        },
      },
    ],
  });
  return { g: TestBed.inject(TodoGraph), items };
}

describe('TodoGraph — ready/blocked derivation', () => {
  it('a to-do that depends on an open to-do is blocked', () => {
    const { g } = make(
      [todo({ ulid: 'a' }), todo({ ulid: 'b', title: 'first', status: 'open' })],
      [link({ from: 'a', kind: 'depends_on', targetKind: 'todo', targetRef: 'b' })],
    );
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('blocked');
    expect(g.blockers('a')).toEqual([{ ulid: 'b', title: 'first' }]);
  });

  it('becomes ready once the dependency is done', () => {
    const { g } = make(
      [todo({ ulid: 'a' }), todo({ ulid: 'b', status: 'done' })],
      [link({ from: 'a', kind: 'depends_on', targetKind: 'todo', targetRef: 'b' })],
    );
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('ready');
    expect(g.blockers('a')).toEqual([]);
  });

  it('a to-do with no dependencies is just open', () => {
    const { g } = make([todo({ ulid: 'a' })], []);
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('open');
  });

  it('an unbought shopping dependency blocks too', () => {
    const { g } = make(
      [todo({ ulid: 'a' })],
      [link({ from: 'a', kind: 'depends_on', targetKind: 'shopping', targetRef: 's1' })],
      [shop({ ulid: 's1', name: 'Milk', done: false })],
    );
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('blocked');
    expect(g.blockers('a')).toEqual([{ ulid: 's1', title: 'Milk' }]);
  });

  it('a bought (ticked) shopping dependency is satisfied', () => {
    const { g } = make(
      [todo({ ulid: 'a' })],
      [link({ from: 'a', kind: 'depends_on', targetKind: 'shopping', targetRef: 's1' })],
      [shop({ ulid: 's1', done: true })],
    );
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('ready');
  });

  it('a shopping dependency already off the list is satisfied', () => {
    const { g } = make(
      [todo({ ulid: 'a' })],
      [link({ from: 'a', kind: 'depends_on', targetKind: 'shopping', targetRef: 'gone' })],
      [],
    );
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('ready');
  });

  it('depends_on a stateless target (recipe/item/room/place) neither blocks nor reads ready', () => {
    const { g } = make(
      [todo({ ulid: 'a' })],
      [link({ from: 'a', kind: 'depends_on', targetKind: 'recipe', targetRef: '3' })],
    );
    // A recipe has no done-ness to derive, so it can't gate readiness — the
    // link is context, and the to-do stays plain open (not fake-"ready").
    expect(g.statusOf(todo({ ulid: 'a' }))).toBe('open');
  });

  it('resolves a link target to its catalog label', () => {
    const { g } = make([todo({ ulid: 'a', title: 'Buy milk' })], []);
    expect(g.resolve('todo', 'a').label).toBe('Buy milk');
    expect(g.search('milk').map((t) => t.ref)).toContain('a');
  });

  it('refreshCatalogs re-fetches the HTTP entity catalogs', () => {
    const { g, items } = make([], []);
    expect(items).toHaveBeenCalledTimes(1); // initial load
    g.refreshCatalogs();
    expect(items).toHaveBeenCalledTimes(2);
  });

  it('a future start-gate makes a to-do "waiting"; a past one does not', () => {
    const { g } = make([], []);
    expect(g.statusOf(todo({ ulid: 'a', notBefore: isoOffset(3) }))).toBe('waiting');
    expect(g.statusOf(todo({ ulid: 'a', notBefore: isoOffset(0) }))).toBe('open'); // today = actionable
    expect(g.statusOf(todo({ ulid: 'a', notBefore: isoOffset(-1) }))).toBe('open');
  });

  it('a blocker outranks a future start-gate (blocked beats waiting)', () => {
    const { g } = make(
      [todo({ ulid: 'a', notBefore: isoOffset(5) }), todo({ ulid: 'b', status: 'open' })],
      [link({ from: 'a', kind: 'depends_on', targetKind: 'todo', targetRef: 'b' })],
    );
    expect(g.statusOf(todo({ ulid: 'a', notBefore: isoOffset(5) }))).toBe('blocked');
  });

  it('urgency is derived from the due date', () => {
    const { g } = make([], []);
    expect(g.urgencyOf(todo({ due: isoOffset(-2) }))).toBe('overdue');
    expect(g.urgencyOf(todo({ due: isoOffset(0) }))).toBe('today');
    expect(g.urgencyOf(todo({ due: isoOffset(2) }))).toBe('soon');
    expect(g.urgencyOf(todo({ due: isoOffset(10) }))).toBe('none');
    expect(g.urgencyOf(todo({ due: isoOffset(-2), status: 'done' }))).toBe('none'); // done clears it
  });
});
