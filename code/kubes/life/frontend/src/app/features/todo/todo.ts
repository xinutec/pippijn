import { Component, computed, inject, signal } from '@angular/core';
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

import { TodoType } from '../../models';
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

  // Form + filters are signals: the app is zoneless, so a signal write is what
  // schedules the view refresh.
  readonly title = signal('');
  readonly newType = signal<TodoType>('purchase');
  readonly notes = signal('');
  /** null = show all types. */
  readonly filter = signal<TodoType | null>(null);
  /** Show only to-dos the graph says are ready (unblocked, with dependencies). */
  readonly readyOnly = signal(false);

  readonly visible = computed(() => {
    const f = this.filter();
    const ready = this.readyOnly();
    return this.items()
      .filter((t) => (f ? t.type === f : true))
      .filter((t) => (ready ? this.graph.statusOf(t) === 'ready' : true));
  });
  readonly readyCount = computed(
    () => this.items().filter((t) => this.graph.statusOf(t) === 'ready').length,
  );

  add(): void {
    const title = this.title().trim();
    if (!title) return;
    void this.store.add({ title, type: this.newType(), notes: this.notes().trim() || null });
    this.title.set('');
    this.notes.set('');
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
