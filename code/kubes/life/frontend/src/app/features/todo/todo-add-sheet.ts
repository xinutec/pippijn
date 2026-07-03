import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { Feedback } from '../../shared/feedback';
import { SheetHeader } from '../../shared/sheet-header';
import { TodoPriority, TodoType } from '../../models';
import { TodoStore } from '../../sync/todo-store';
import { PRIORITIES, TODO_TYPES } from './todo-meta';

/** Quick-capture sheet for a new to-do (the FAB's action). Stays open after
 *  each add — brain-dumps come in bursts — clear, notify, refocus. Everything
 *  beyond capture (links, timing presets, status) lives in the detail sheet. */
@Component({
  selector: 'app-todo-add-sheet',
  templateUrl: './todo-add-sheet.html',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    SheetHeader,
  ],
})
export class TodoAddSheet {
  private ref = inject(MatBottomSheetRef<TodoAddSheet>);
  private store = inject(TodoStore);
  private feedback = inject(Feedback);

  readonly types = TODO_TYPES;
  readonly priorities = PRIORITIES;

  readonly title = signal('');
  readonly type = signal<TodoType>('purchase');
  readonly priority = signal<TodoPriority | null>(null);
  readonly due = signal<string | null>(null);
  readonly notes = signal('');

  add(): void {
    const title = this.title().trim();
    if (!title) return;
    void this.store.add({
      title,
      type: this.type(),
      priority: this.priority(),
      notes: this.notes().trim() || null,
      due: this.due(),
    });
    this.feedback.notify(`Added ${title}`);
    this.title.set('');
    this.notes.set('');
    this.priority.set(null);
    this.due.set(null);
    document.querySelector<HTMLElement>('app-todo-add-sheet input')?.focus();
  }

  close(): void {
    this.ref.dismiss();
  }
}
