import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';

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

export type TodoState = 'done' | 'blocked' | 'waiting' | 'ready' | 'open';

/** Deadline pressure, orthogonal to `TodoState`. Derived from `due` vs today. */
export type Urgency = 'overdue' | 'today' | 'soon' | 'none';

/** The device-local calendar day as `YYYY-MM-DD` (the user's day, not UTC). */
function todayISO(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

  // "Today" as a signal so waiting/overdue states recompute when the day rolls
  // over or the app regains focus — no reload needed. Updated at midnight and on
  // visibility regain.
  private readonly _today = signal(todayISO());
  readonly today = this._today.asReadonly();

  constructor() {
    const refresh = () => this._today.set(todayISO());
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh();
      });
    }
    const scheduleMidnight = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
      setTimeout(() => {
        refresh();
        scheduleMidnight();
      }, next.getTime() - now.getTime());
    };
    scheduleMidnight();
  }

  /** Whole days from today to an ISO date (negative = in the past). */
  daysUntil(iso: string): number {
    const a = Date.parse(this.today() + 'T00:00:00Z');
    const b = Date.parse(iso + 'T00:00:00Z');
    return Math.round((b - a) / 86_400_000);
  }

  /** Deadline pressure from `due`. Done or undated to-dos have none. */
  urgencyOf(todo: TodoDoc): Urgency {
    if (todo.status === 'done' || !todo.due) return 'none';
    const d = this.daysUntil(todo.due);
    if (d < 0) return 'overdue';
    if (d === 0) return 'today';
    if (d <= 3) return 'soon';
    return 'none';
  }

  readonly todoItems = toSignal(this.todos.items$, { initialValue: [] as TodoDoc[] });
  readonly links = toSignal(this.linkStore.links$, { initialValue: [] as TodoLinkDoc[] });
  private readonly shoppingItems = toSignal(this.shopping.items$, {
    initialValue: [] as ShoppingDoc[],
  });

  // The HTTP catalogs re-fetch on every refreshCatalogs() tick — a service
  // created once would otherwise never see an item/recipe/place added later
  // in the session, making it unlinkable until a full reload.
  private readonly refresh$ = new BehaviorSubject<void>(undefined);
  private refreshed<T>(fetch: () => Observable<T>, empty: T) {
    return toSignal(this.refresh$.pipe(switchMap(() => fetch().pipe(catchError(() => of(empty))))), {
      initialValue: empty,
    });
  }

  private readonly items = this.refreshed(() => this.api.items(), []);
  private readonly recipes = this.refreshed(() => this.api.recipes(), []);
  private readonly places = this.refreshed(() => this.api.locations(), []);
  private readonly rooms = this.refreshed(
    () =>
      this.api
        .house()
        .pipe(map((h) => (h.rooms ?? []).map((r) => r.name).filter((n): n is string => !!n))),
    [] as string[],
  );

  /** Re-fetch the HTTP entity catalogs (items/recipes/places/rooms). Called on
   *  entering the to-do view and on opening the detail sheet, so fresh entities
   *  are linkable without reloading the app. */
  refreshCatalogs(): void {
    this.refresh$.next(undefined);
  }

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

  /** The unfinished dependencies of a to-do. Two target kinds have derivable
   *  done-ness and can block: another **to-do** (open = blocking) and a
   *  **shopping row** (on the list and not ticked = blocking; bought/removed =
   *  satisfied). Other kinds (recipe/item/room/place) have no completion state
   *  — those links are context, not gates. */
  blockers(todoUlid: string): { ulid: string; title: string }[] {
    const todoMap = this.todoByUlid();
    const shopMap = new Map(this.shoppingItems().map((s) => [s.ulid, s] as const));
    const out: { ulid: string; title: string }[] = [];
    for (const l of this.links()) {
      if (l.from !== todoUlid || l.kind !== 'depends_on') continue;
      if (l.targetKind === 'todo') {
        const t = todoMap.get(l.targetRef);
        if (t && t.status !== 'done') out.push({ ulid: t.ulid, title: t.title });
      } else if (l.targetKind === 'shopping') {
        const s = shopMap.get(l.targetRef);
        if (s && !s.done) out.push({ ulid: s.ulid, title: s.name });
      }
    }
    return out;
  }

  /** Derived lifecycle state, in precedence order: done → blocked (an unfinished
   *  dependency) → waiting (a future start-gate) → ready (open with deps, all
   *  met) → open. An external gate (blocker) outranks a self-imposed one
   *  (not_before). Links to stateless targets don't make a to-do "ready". */
  statusOf(todo: TodoDoc): TodoState {
    if (todo.status === 'done') return 'done';
    if (this.blockers(todo.ulid).length > 0) return 'blocked';
    if (todo.notBefore && this.daysUntil(todo.notBefore) > 0) return 'waiting';
    const hasDeps = this.links().some(
      (l) =>
        l.from === todo.ulid &&
        l.kind === 'depends_on' &&
        (l.targetKind === 'todo' || l.targetKind === 'shopping'),
    );
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
