import { afterNextRender, Component, computed, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatBottomSheet, MatBottomSheetModule } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatSelectModule } from '@angular/material/select';

import { TodoPriority, TodoType } from '../../models';
import { TodoDoc, TodoStore } from '../../sync/todo-store';
import { TodoDetail } from './todo-detail';
import { TodoGraph, TodoState } from './todo-graph';

/** The to-do types, with display label + Material icon. Extend alongside the
 *  backend `TodoType` enum when a new kind is added. */
const TYPES: readonly { value: TodoType; label: string; icon: string }[] = [
  { value: 'purchase', label: 'Purchase', icon: 'shopping_bag' },
  { value: 'call', label: 'Call', icon: 'call' },
  { value: 'appointment', label: 'Appointment', icon: 'event' },
  { value: 'admin', label: 'Admin', icon: 'description' },
  { value: 'task', label: 'Task', icon: 'task_alt' },
];

export const PRIORITIES: readonly { value: TodoPriority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];
const PRIO_RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 };
/** Sort rank: high → medium → low → unset. */
export const prioRank = (p: TodoPriority | null): number => (p ? PRIO_RANK[p] : 3);

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
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonToggleModule,
    MatBottomSheetModule,
  ],
})
export class Todo {
  private store = inject(TodoStore);
  private sheet = inject(MatBottomSheet);
  readonly graph = inject(TodoGraph);

  // Local-first: the list is the live RxDB query — instant, offline, reactive.
  readonly items = toSignal(this.store.items$, { initialValue: [] as TodoDoc[] });
  readonly syncError = this.store.syncError;
  readonly types = TYPES;
  readonly priorities = PRIORITIES;

  // Form + filters are signals: the app is zoneless, so a signal write is what
  // schedules the view refresh.
  readonly title = signal('');
  readonly newType = signal<TodoType>('purchase');
  readonly newPriority = signal<TodoPriority | null>(null);
  readonly notes = signal('');
  /** null = show all types. */
  readonly filter = signal<TodoType | null>(null);
  /** Show only to-dos the graph says are ready (unblocked, with dependencies). */
  readonly readyOnly = signal(false);

  // Type-filter row fade hint: only show the right-edge fade while there's
  // more to scroll to, not once the last chip is fully in view.
  private readonly filterScroll = viewChild<{ nativeElement: HTMLDivElement }>('filterScroll');
  readonly filterCanScrollRight = signal(false);

  constructor() {
    afterNextRender(() => this.updateFilterScrollFade());
  }

  onFilterScroll(): void {
    this.updateFilterScrollFade();
  }

  private updateFilterScrollFade(): void {
    const el = this.filterScroll()?.nativeElement;
    if (!el) return;
    this.filterCanScrollRight.set(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }

  readonly visible = computed(() => {
    const f = this.filter();
    const ready = this.readyOnly();
    // Open before done, then by priority (high→low→unset), then title.
    return this.items()
      .filter((t) => (f ? t.type === f : true))
      .filter((t) => (ready ? this.graph.statusOf(t) === 'ready' : true))
      .slice()
      .sort(
        (a, b) =>
          Number(a.status === 'done') - Number(b.status === 'done') ||
          prioRank(a.priority) - prioRank(b.priority) ||
          a.title.localeCompare(b.title),
      );
  });
  readonly readyCount = computed(
    () => this.items().filter((t) => this.graph.statusOf(t) === 'ready').length,
  );

  add(): void {
    const title = this.title().trim();
    if (!title) return;
    void this.store.add({
      title,
      type: this.newType(),
      priority: this.newPriority(),
      notes: this.notes().trim() || null,
    });
    this.title.set('');
    this.notes.set('');
    this.newPriority.set(null);
  }

  setPriority(it: TodoDoc, priority: TodoPriority | null): void {
    void this.store.patch(it.ulid, { priority });
  }

  priorityLabel(p: TodoPriority): string {
    return PRIORITIES.find((x) => x.value === p)?.label ?? p;
  }

  toggle(it: TodoDoc): void {
    void this.store.setStatus(it.ulid, it.status === 'done' ? 'open' : 'done');
  }

  remove(it: TodoDoc): void {
    this.graph.removeLinksForTodo(it.ulid);
    void this.store.remove(it.ulid);
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
    return TYPES.find((t) => t.value === type)?.icon ?? 'task_alt';
  }

  typeLabel(type: TodoType): string {
    return TYPES.find((t) => t.value === type)?.label ?? type;
  }
}
