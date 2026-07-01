import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MatBottomSheet,
  MatBottomSheetRef,
  MAT_BOTTOM_SHEET_DATA,
} from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';

import { LinkKind, TodoType } from '../../models';
import { TodoStore } from '../../sync/todo-store';
import { LinkTarget, TodoGraph } from './todo-graph';

const TYPES: readonly { value: TodoType; label: string; icon: string }[] = [
  { value: 'purchase', label: 'Purchase', icon: 'shopping_bag' },
  { value: 'call', label: 'Call', icon: 'call' },
  { value: 'appointment', label: 'Appointment', icon: 'event' },
  { value: 'admin', label: 'Admin', icon: 'description' },
  { value: 'task', label: 'Task', icon: 'task_alt' },
];

const KINDS: readonly { value: LinkKind; label: string }[] = [
  { value: 'depends_on', label: 'Depends on' },
  { value: 'subtask', label: 'Subtask' },
  { value: 'related', label: 'Related' },
];

/** A connection group for display: a heading + its resolved rows. Each row is an
 *  edge (`edge` = its ulid, for removal) pointing at a `target`; `todoRef` is set
 *  when the target is itself a to-do, so we can traverse to it. */
interface Group {
  heading: string;
  rows: { edge: string; target: LinkTarget; todoRef: string | null }[];
}

@Component({
  selector: 'app-todo-detail',
  templateUrl: './todo-detail.html',
  styleUrl: './todo-detail.scss',
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
  ],
})
export class TodoDetail {
  private ref = inject(MatBottomSheetRef<TodoDetail>);
  private data = inject<{ ulid: string }>(MAT_BOTTOM_SHEET_DATA);
  private store = inject(TodoStore);
  private sheet = inject(MatBottomSheet);
  readonly graph = inject(TodoGraph);

  readonly types = TYPES;
  readonly kinds = KINDS;
  readonly ulid = signal(this.data.ulid);

  /** The live to-do (may update while the sheet is open). */
  readonly todo = computed(() => this.graph.todoItems().find((t) => t.ulid === this.ulid()));
  readonly state = computed(() => {
    const t = this.todo();
    return t ? this.graph.statusOf(t) : 'open';
  });
  readonly blockers = computed(() => this.graph.blockers(this.ulid()));

  /** Connections grouped by relationship + direction, resolved for display. */
  readonly groups = computed<Group[]>(() => {
    const out = this.graph.outgoing(this.ulid());
    const inc = this.graph.incoming(this.ulid());
    const toTodoRef = (t: LinkTarget) => (t.kind === 'todo' ? t.ref : null);
    const g: Group[] = [
      {
        heading: 'Depends on',
        rows: out
          .filter((l) => l.linkKind === 'depends_on')
          .map((l) => ({ edge: l.ulid, target: l.target, todoRef: toTodoRef(l.target) })),
      },
      {
        heading: 'Needed by',
        rows: inc
          .filter((l) => l.linkKind === 'depends_on')
          .map((l) => ({ edge: l.ulid, target: l.source, todoRef: l.source.ref })),
      },
      {
        heading: 'Subtasks',
        rows: out
          .filter((l) => l.linkKind === 'subtask')
          .map((l) => ({ edge: l.ulid, target: l.target, todoRef: toTodoRef(l.target) })),
      },
      {
        heading: 'Part of',
        rows: inc
          .filter((l) => l.linkKind === 'subtask')
          .map((l) => ({ edge: l.ulid, target: l.source, todoRef: l.source.ref })),
      },
      {
        heading: 'Related',
        rows: [
          ...out.filter((l) => l.linkKind === 'related').map((l) => ({ edge: l.ulid, target: l.target, todoRef: toTodoRef(l.target) })),
          ...inc.filter((l) => l.linkKind === 'related').map((l) => ({ edge: l.ulid, target: l.source, todoRef: l.source.ref })),
        ],
      },
    ];
    return g.filter((grp) => grp.rows.length > 0);
  });

  // Inline edit — seeded once from the to-do; patched on change.
  readonly title = signal(this.todo()?.title ?? '');
  readonly notes = signal(this.todo()?.notes ?? '');

  // Add-connection form.
  readonly addKind = signal<LinkKind>('related');
  readonly query = signal('');
  readonly results = computed(() => this.graph.search(this.query(), this.ulid()));

  typeMeta(type: TodoType) {
    return TYPES.find((t) => t.value === type) ?? { label: type, icon: 'task_alt' };
  }

  saveTitle(): void {
    const t = this.title().trim();
    if (t) void this.store.patch(this.ulid(), { title: t });
  }

  saveNotes(): void {
    void this.store.patch(this.ulid(), { notes: this.notes().trim() || null });
  }

  setType(type: TodoType): void {
    void this.store.patch(this.ulid(), { type });
  }

  toggleDone(): void {
    const t = this.todo();
    if (t) void this.store.setStatus(this.ulid(), t.status === 'done' ? 'open' : 'done');
  }

  addLink(target: LinkTarget): void {
    this.graph.add({
      from: this.ulid(),
      kind: this.addKind(),
      targetKind: target.kind,
      targetRef: target.ref,
    });
    this.query.set('');
  }

  removeLink(edge: string): void {
    this.graph.removeLink(edge);
  }

  /** Traverse: reopen the sheet on a linked to-do. */
  openTodo(ref: string): void {
    this.ref.dismiss();
    this.sheet.open(TodoDetail, { data: { ulid: ref } });
  }

  remove(): void {
    const key = this.ulid();
    this.graph.removeLinksForTodo(key);
    void this.store.remove(key);
    this.ref.dismiss();
  }

  close(): void {
    this.ref.dismiss();
  }
}
