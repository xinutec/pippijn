import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MatBottomSheet,
  MatBottomSheetRef,
  MAT_BOTTOM_SHEET_DATA,
} from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';

import { Feedback } from '../../shared/feedback';
import { LifeApi } from '../../life-api';
import { LinkKind, TodoPriority, TodoType } from '../../models';
import { TodoStore } from '../../sync/todo-store';
import { LinkTarget, TodoGraph } from './todo-graph';
import { PRIORITIES, TODO_TYPES } from './todo-meta';

const KINDS: readonly { value: LinkKind; label: string }[] = [
  { value: 'depends_on', label: 'Depends on' },
  { value: 'subtask', label: 'Subtask' },
  { value: 'related', label: 'Related' },
];

/** ISO date for a quick-pick preset, relative to today (device-local). */
function presetDate(kind: 'today' | 'tomorrow' | 'weekend' | 'nextweek'): string {
  const d = new Date();
  if (kind === 'tomorrow') d.setDate(d.getDate() + 1);
  else if (kind === 'weekend') d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7)); // next Sat
  else if (kind === 'nextweek') d.setDate(d.getDate() + (((1 - d.getDay() + 7) % 7) || 7)); // next Mon
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
    MatCheckboxModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
  ],
})
export class TodoDetail implements OnDestroy {
  private deleting = false;

  // Dismissing the sheet (backdrop tap / swipe) may not fire the title/notes
  // blur handlers, which is where edits are saved — flush on teardown so an
  // in-progress edit isn't lost. Skipped when the to-do is being deleted.
  ngOnDestroy(): void {
    if (this.deleting) return;
    const t = this.todo();
    if (!t) return;
    const title = this.title().trim();
    if (title && title !== t.title) void this.store.patch(this.ulid(), { title });
    const notes = this.notes().trim() || null;
    if (notes !== (t.notes ?? null)) void this.store.patch(this.ulid(), { notes });
  }

  private ref = inject(MatBottomSheetRef<TodoDetail>);
  private data = inject<{ ulid: string }>(MAT_BOTTOM_SHEET_DATA);
  private store = inject(TodoStore);
  private sheet = inject(MatBottomSheet);
  private api = inject(LifeApi);
  private feedback = inject(Feedback);
  readonly graph = inject(TodoGraph);

  constructor() {
    // The link search must see entities added since the catalogs last loaded.
    this.graph.refreshCatalogs();
  }

  readonly types = TODO_TYPES;
  readonly kinds = KINDS;
  readonly priorities = PRIORITIES;
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
    return TODO_TYPES.find((t) => t.value === type) ?? { label: type, icon: 'task_alt' };
  }

  saveTitle(): void {
    const t = this.title().trim();
    if (t) void this.store.patch(this.ulid(), { title: t });
  }

  saveNotes(): void {
    void this.store.patch(this.ulid(), { notes: this.notes().trim() || null });
  }

  // The chip listboxes emit undefined on a deselect. The selected chip is
  // locked ([selectable]=false), so that shouldn't happen — but guard anyway:
  // type always has a value, and priority's "none" is the explicit null chip.
  setType(type: TodoType | undefined): void {
    if (type == null) return;
    void this.store.patch(this.ulid(), { type });
  }

  setPriority(priority: TodoPriority | null | undefined): void {
    if (priority === undefined) return;
    void this.store.patch(this.ulid(), { priority });
  }

  setAddKind(kind: LinkKind | undefined): void {
    if (kind == null) return;
    this.addKind.set(kind);
  }

  readonly datePresets = [
    { label: 'Today', kind: 'today' },
    { label: 'Tomorrow', kind: 'tomorrow' },
    { label: 'Weekend', kind: 'weekend' },
    { label: 'Next week', kind: 'nextweek' },
  ] as const;

  // A cleared native date input emits '' — store that as null, not an empty date.
  private clean(v: string | null): string | null {
    return v && v.trim().length > 0 ? v : null;
  }

  setNotBefore(v: string | null): void {
    void this.store.patch(this.ulid(), { notBefore: this.clean(v) });
  }

  setDue(v: string | null): void {
    void this.store.patch(this.ulid(), { due: this.clean(v) });
  }

  applyPreset(field: 'notBefore' | 'due', kind: 'today' | 'tomorrow' | 'weekend' | 'nextweek'): void {
    const iso = presetDate(kind);
    if (field === 'notBefore') this.setNotBefore(iso);
    else this.setDue(iso);
  }

  toggleDone(): void {
    const t = this.todo();
    if (!t) return;
    // Can't complete a blocked to-do (checkbox is disabled too); un-completing
    // a done one is always fine.
    if (t.status !== 'done' && this.state() === 'blocked') return;
    void this.store.setStatus(this.ulid(), t.status === 'done' ? 'open' : 'done');
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
    const doc = this.todo();
    this.deleting = true; // don't let ngOnDestroy re-save the row we're removing
    void this.store.remove(key);
    this.ref.dismiss();
    if (!doc) return;
    // Undo mirrors the list view: revive locally + authoritative server restore
    // for synced rows. Link removal is deferred to the Undo window's close so an
    // undo brings the to-do back with its connections intact.
    this.feedback.undo(
      `Deleted “${doc.title}”`,
      () => {
        void this.store.revive(doc);
        if (doc.id != null) {
          this.api.restoreTrash('todo', doc.ulid).subscribe({
            next: () => this.store.reSync(),
            error: () => {},
          });
        }
      },
      () => this.graph.removeLinksForTodo(key),
    );
  }

  close(): void {
    this.ref.dismiss();
  }
}
