import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { LifeApi } from '../../life-api';
import { LinkKind, TargetKind } from '../../models';
import { ShoppingDoc, ShoppingStore } from '../../sync/shopping-store';
import { TodoLinkDoc, TodoLinkStore } from '../../sync/todo-link-store';
import { TodoDoc, TodoStore } from '../../sync/todo-store';

/** Something a to-do can point at, resolved to a display label + icon. */
export interface LinkTarget {
  kind: TargetKind;
  ref: string;
  label: string;
  icon: string;
}

export interface ResolvedLink {
  ulid: string; // the edge's own ulid
  linkKind: LinkKind;
  target: LinkTarget;
}

export type TodoState = 'done' | 'blocked' | 'ready' | 'open';

const TARGET_ICON: Record<TargetKind, string> = {
  todo: 'task_alt',
  item: 'inventory_2',
  recipe: 'menu_book',
  room: 'meeting_room',
  shopping: 'shopping_cart',
  place: 'place',
};

/** The connection graph: it fuses the to-do + link stores with the app's entity
 *  catalogs (items / recipes / rooms / shopping / places) so a link can be
 *  resolved to a label, searched for, and — the powerful bit — used to derive
 *  whether a to-do is *ready* or *blocked*. All signal-driven (zoneless). Entity
 *  catalogs come from the HTTP API (SW-cached, so they work offline) and fail
 *  soft to empty. */
@Injectable({ providedIn: 'root' })
export class TodoGraph {
  private todos = inject(TodoStore);
  private linkStore = inject(TodoLinkStore);
  private shopping = inject(ShoppingStore);
  private api = inject(LifeApi);

  readonly todoItems = toSignal(this.todos.items$, { initialValue: [] as TodoDoc[] });
  readonly links = toSignal(this.linkStore.links$, { initialValue: [] as TodoLinkDoc[] });
  private readonly shoppingItems = toSignal(this.shopping.items$, {
    initialValue: [] as ShoppingDoc[],
  });

  private readonly items = toSignal(this.api.items().pipe(catchError(() => of([]))), {
    initialValue: [],
  });
  private readonly recipes = toSignal(this.api.recipes().pipe(catchError(() => of([]))), {
    initialValue: [],
  });
  private readonly places = toSignal(this.api.locations().pipe(catchError(() => of([]))), {
    initialValue: [],
  });
  private readonly rooms = toSignal(
    this.api.house().pipe(
      map((h) => (h.rooms ?? []).map((r) => r.name).filter((n): n is string => !!n)),
      catchError(() => of([] as string[])),
    ),
    { initialValue: [] as string[] },
  );

  /** Every linkable thing, flattened into a searchable catalog. */
  readonly catalog = computed<LinkTarget[]>(() => {
    const out: LinkTarget[] = [];
    for (const t of this.todoItems())
      out.push({ kind: 'todo', ref: t.ulid, label: t.title, icon: TARGET_ICON.todo });
    for (const i of this.items())
      out.push({ kind: 'item', ref: String(i.id), label: i.name, icon: TARGET_ICON.item });
    for (const r of this.recipes())
      out.push({ kind: 'recipe', ref: String(r.id), label: r.name, icon: TARGET_ICON.recipe });
    for (const name of this.rooms())
      out.push({ kind: 'room', ref: name, label: name, icon: TARGET_ICON.room });
    for (const s of this.shoppingItems())
      out.push({ kind: 'shopping', ref: s.ulid, label: s.name, icon: TARGET_ICON.shopping });
    for (const p of this.places())
      out.push({ kind: 'place', ref: String(p.id), label: p.name, icon: TARGET_ICON.place });
    return out;
  });

  private readonly byKey = computed(() => {
    const m = new Map<string, LinkTarget>();
    for (const t of this.catalog()) m.set(t.kind + ':' + t.ref, t);
    return m;
  });

  private readonly todoByUlid = computed(() => {
    const m = new Map<string, TodoDoc>();
    for (const t of this.todoItems()) m.set(t.ulid, t);
    return m;
  });

  resolve(kind: TargetKind, ref: string): LinkTarget {
    return (
      this.byKey().get(kind + ':' + ref) ?? { kind, ref, label: '(deleted)', icon: TARGET_ICON[kind] }
    );
  }

  /** Unified search across everything linkable (excluding the given to-do). */
  search(query: string, excludeTodo?: string): LinkTarget[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.catalog()
      .filter((t) => !(t.kind === 'todo' && t.ref === excludeTodo))
      .filter((t) => t.label.toLowerCase().includes(q))
      .slice(0, 25);
  }

  /** Outgoing edges from a to-do, resolved. */
  outgoing(todoUlid: string): ResolvedLink[] {
    return this.links()
      .filter((l) => l.from === todoUlid)
      .map((l) => ({ ulid: l.ulid, linkKind: l.kind, target: this.resolve(l.targetKind, l.targetRef) }));
  }

  /** Incoming edges — other to-dos pointing at this one — resolved to the source. */
  incoming(todoUlid: string): { ulid: string; linkKind: LinkKind; source: LinkTarget }[] {
    return this.links()
      .filter((l) => l.targetKind === 'todo' && l.targetRef === todoUlid)
      .map((l) => ({ ulid: l.ulid, linkKind: l.kind, source: this.resolve('todo', l.from) }));
  }

  /** The still-open to-dos this one depends on (its blockers). */
  blockers(todoUlid: string): TodoDoc[] {
    const map = this.todoByUlid();
    return this.links()
      .filter((l) => l.from === todoUlid && l.kind === 'depends_on' && l.targetKind === 'todo')
      .map((l) => map.get(l.targetRef))
      .filter((t): t is TodoDoc => !!t && t.status !== 'done');
  }

  /** Derived lifecycle state: blocked while a depends-on to-do is open; ready =
   *  open, has dependencies, and none are blocking. */
  statusOf(todo: TodoDoc): TodoState {
    if (todo.status === 'done') return 'done';
    if (this.blockers(todo.ulid).length > 0) return 'blocked';
    const hasDeps = this.links().some((l) => l.from === todo.ulid && l.kind === 'depends_on');
    return hasDeps ? 'ready' : 'open';
  }

  /** How many edges touch a to-do (either direction). */
  linkCount(todoUlid: string): number {
    return this.links().filter(
      (l) => l.from === todoUlid || (l.targetKind === 'todo' && l.targetRef === todoUlid),
    ).length;
  }

  add(input: { from: string; kind: LinkKind; targetKind: TargetKind; targetRef: string }): void {
    void this.linkStore.add(input);
  }

  removeLink(edgeUlid: string): void {
    void this.linkStore.remove(edgeUlid);
  }

  /** Remove every edge touching a to-do (used when the to-do is deleted). */
  removeLinksForTodo(todoUlid: string): void {
    void this.linkStore.removeForTodo(todoUlid);
  }
}
