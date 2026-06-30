import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
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

/** The to-do types, with display label + Material icon. Extend alongside the
 *  backend `TodoType` enum when a new kind is added. */
const TYPES: readonly { value: TodoType; label: string; icon: string }[] = [
  { value: 'purchase', label: 'Purchase', icon: 'shopping_bag' },
  { value: 'call', label: 'Call', icon: 'call' },
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
  ],
})
export class Todo {
  private store = inject(TodoStore);

  // Local-first: the list is the live RxDB query — instant, offline, reactive.
  readonly items = toSignal(this.store.items$, { initialValue: [] as TodoDoc[] });
  readonly syncError = this.store.syncError;
  readonly types = TYPES;

  // Form + filter are signals: the app is zoneless, so a signal write is what
  // schedules the view refresh.
  readonly title = signal('');
  readonly newType = signal<TodoType>('purchase');
  readonly notes = signal('');
  /** null = show all types. */
  readonly filter = signal<TodoType | null>(null);

  readonly visible = computed(() => {
    const f = this.filter();
    return f ? this.items().filter((t) => t.type === f) : this.items();
  });
  readonly openCount = computed(() => this.items().filter((t) => t.status === 'open').length);

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

  setType(it: TodoDoc, type: TodoType): void {
    void this.store.patch(it.ulid, { type });
  }

  remove(key: string): void {
    void this.store.remove(key);
  }

  typeIcon(type: TodoType): string {
    return TYPES.find((t) => t.value === type)?.icon ?? 'task_alt';
  }

  typeLabel(type: TodoType): string {
    return TYPES.find((t) => t.value === type)?.label ?? type;
  }
}
