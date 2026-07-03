import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatBottomSheet, MatBottomSheetModule } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { map } from 'rxjs';

import { Feedback } from '../../shared/feedback';
import { ListState } from '../../shared/list-state';
import { LifeApi } from '../../life-api';
import { TodoPriority, TodoType } from '../../models';
import { TodoDoc, TodoStore } from '../../sync/todo-store';
import { TodoAddSheet } from './todo-add-sheet';
import { TodoDetail } from './todo-detail';
import { TodoGraph, TodoState } from './todo-graph';
import { PRIORITIES, TODO_TYPES, prioRank } from './todo-meta';

@Component({
  selector: 'app-todo',
  templateUrl: './todo.html',
  styleUrl: './todo.scss',
  imports: [
    FormsModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatCheckboxModule,
    MatChipsModule,
    MatBottomSheetModule,
    ListState,
  ],
})
export class Todo {
  private store = inject(TodoStore);
  private sheet = inject(MatBottomSheet);
  private api = inject(LifeApi);
  private feedback = inject(Feedback);
  readonly graph = inject(TodoGraph);

  constructor() {
    // Entities added since the last visit become linkable/resolvable.
    this.graph.refreshCatalogs();
  }

  // Local-first: the list is the live RxDB query — instant, offline, reactive.
  readonly items = toSignal(this.store.items$, { initialValue: [] as TodoDoc[] });
  /** False until the local DB has produced its first result — cold start shows a
   *  spinner, not a flash of "no to-dos". */
  readonly loaded = toSignal(this.store.items$.pipe(map(() => true)), { initialValue: false });
  readonly syncError = this.store.syncError;
  readonly types = TODO_TYPES;
  readonly priorities = PRIORITIES;

  /** The FAB's action: the quick-capture sheet. */
  openAdd(): void {
    this.sheet.open(TodoAddSheet);
  }

  // Filters are signals: the app is zoneless, so a signal write is what
  // schedules the view refresh.
  /** null = show all types. */
  readonly filter = signal<TodoType | null>(null);
  /** Show only to-dos the graph says are ready (unblocked, with dependencies). */
  readonly readyOnly = signal(false);
  /** Whether the collapsed "Waiting" section is expanded. */
  readonly showWaiting = signal(false);

  /** Actionable to-dos (waiting ones are split into their own section below).
   *  Order: open-before-done → urgency (overdue→today→soon→later) → priority →
   *  due date → title. */
  readonly visible = computed(() => {
    const f = this.filter();
    const ready = this.readyOnly();
    return this.items()
      .filter((t) => (f ? t.type === f : true))
      .filter((t) => this.graph.statusOf(t) !== 'waiting')
      .filter((t) => (ready ? this.graph.statusOf(t) === 'ready' : true))
      .slice()
      .sort(this.compare);
  });

  /** To-dos gated by a future start date — parked in a collapsed section so the
   *  main list only shows what can be acted on. Hidden entirely under "Ready". */
  readonly waiting = computed(() => {
    if (this.readyOnly()) return [] as TodoDoc[];
    const f = this.filter();
    return this.items()
      .filter((t) => (f ? t.type === f : true))
      .filter((t) => this.graph.statusOf(t) === 'waiting')
      .slice()
      .sort(
        (a, b) =>
          (a.notBefore ?? '').localeCompare(b.notBefore ?? '') || a.title.localeCompare(b.title),
      );
  });
  readonly waitingCount = computed(() => this.waiting().length);

  readonly readyCount = computed(
    () => this.items().filter((t) => this.graph.statusOf(t) === 'ready').length,
  );

  private urgencyRank(t: TodoDoc): number {
    switch (this.graph.urgencyOf(t)) {
      case 'overdue':
        return 0;
      case 'today':
        return 1;
      case 'soon':
        return 2;
      default:
        return 3;
    }
  }
  private compare = (a: TodoDoc, b: TodoDoc): number =>
    Number(a.status === 'done') - Number(b.status === 'done') ||
    this.urgencyRank(a) - this.urgencyRank(b) ||
    prioRank(a.priority) - prioRank(b.priority) ||
    (a.due ?? '9999-99-99').localeCompare(b.due ?? '9999-99-99') ||
    a.title.localeCompare(b.title);

  /** The urgency chip for a row, or null when there's nothing pressing to show
   *  (done, undated, or a deadline more than 3 days out). */
  dueChip(it: TodoDoc): { label: string; cls: string } | null {
    const u = this.graph.urgencyOf(it);
    if (u === 'none' || !it.due) return null;
    const d = this.graph.daysUntil(it.due);
    let label: string;
    if (u === 'overdue') label = d === -1 ? 'overdue 1d' : `overdue ${-d}d`;
    else if (u === 'today') label = 'due today';
    else label = d === 1 ? 'due tomorrow' : `due in ${d}d`;
    return { label, cls: u === 'soon' ? 'due-soon' : 'overdue' };
  }

  /** "from Sat 5 Jul" — when a waiting to-do becomes actionable. */
  fromLabel(it: TodoDoc): string {
    if (!it.notBefore) return '';
    const d = new Date(it.notBefore + 'T00:00:00');
    return 'from ' + d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  setPriority(it: TodoDoc, priority: TodoPriority | null): void {
    void this.store.patch(it.ulid, { priority });
  }

  priorityLabel(p: TodoPriority): string {
    return PRIORITIES.find((x) => x.value === p)?.label ?? p;
  }

  toggle(it: TodoDoc): void {
    // A blocked to-do (an unfinished dependency) can't be completed — the
    // checkbox is disabled too, this guards the programmatic path. Un-completing
    // a done item is always allowed (a done item is never "blocked").
    if (it.status !== 'done' && this.graph.statusOf(it) === 'blocked') return;
    void this.store.setStatus(it.ulid, it.status === 'done' ? 'open' : 'done');
  }

  remove(it: TodoDoc): void {
    // Remove the to-do now (optimistic), but DEFER removing its connections
    // until the Undo window closes — so an undo brings the to-do back with its
    // links intact. Undo: revive locally (works offline) + server-side restore
    // for synced rows (a re-push can't clear a tombstone; a 404 just means the
    // delete push hadn't arrived, and revive covers it).
    void this.store.remove(it.ulid);
    this.feedback.undo(
      `Deleted “${it.title}”`,
      () => {
        void this.store.revive(it);
        if (it.id != null) {
          this.api.restoreTrash('todo', it.ulid).subscribe({
            next: () => this.store.reSync(),
            error: () => {},
          });
        }
      },
      () => this.graph.removeLinksForTodo(it.ulid),
    );
  }

  openDetail(it: TodoDoc): void {
    this.sheet.open(TodoDetail, { data: { ulid: it.ulid } });
  }

  stateOf(it: TodoDoc): TodoState {
    return this.graph.statusOf(it);
  }

  blockerCount(it: TodoDoc): number {
    return this.graph.blockers(it.ulid).length;
  }

  linkCount(it: TodoDoc): number {
    return this.graph.linkCount(it.ulid);
  }

  typeIcon(type: TodoType): string {
    return TODO_TYPES.find((t) => t.value === type)?.icon ?? 'task_alt';
  }

  typeLabel(type: TodoType): string {
    return TODO_TYPES.find((t) => t.value === type)?.label ?? type;
  }
}
