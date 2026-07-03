import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';

import { Feedback } from '../../shared/feedback';
import { ListState } from '../../shared/list-state';
import { LifeApi } from '../../life-api';
import { TrashEntry, TrashKind } from '../../models';
import { ShoppingStore } from '../../sync/shopping-store';
import { TodoStore } from '../../sync/todo-store';
import { WellbeingStore } from '../../sync/wellbeing-store';

/** Icon + label per kind — matching the nav so the origin is recognisable. */
const KIND_META: Record<TrashKind, { icon: string; label: string }> = {
  item: { icon: 'inventory_2', label: 'Item' },
  location: { icon: 'place', label: 'Place' },
  recipe: { icon: 'menu_book', label: 'Recipe' },
  shopping: { icon: 'shopping_cart', label: 'Buy' },
  todo: { icon: 'checklist', label: 'To-do' },
  wellbeing: { icon: 'mood', label: 'Wellbeing' },
};

/** Recently deleted — everything ever deleted, restorable with one tap.
 *  Deletes only ever tombstone; this is the way back. Online-only (the trash
 *  lives on the server). */
@Component({
  selector: 'app-trash',
  templateUrl: './trash.html',
  styleUrl: './trash.scss',
  imports: [DatePipe, MatButtonModule, MatIconModule, MatListModule, ListState],
})
export class Trash {
  private api = inject(LifeApi);
  private feedback = inject(Feedback);
  private shoppingStore = inject(ShoppingStore);
  private todoStore = inject(TodoStore);
  private wellbeingStore = inject(WellbeingStore);

  readonly entries = signal<TrashEntry[]>([]);
  /** Distinguish "still loading" from "trash is empty" — no false empty flash. */
  readonly loaded = signal(false);
  /** Refs with a restore in flight (disables their button). */
  readonly busy = signal<ReadonlySet<string>>(new Set());

  constructor() {
    this.reload();
  }

  meta(kind: TrashKind): { icon: string; label: string } {
    return KIND_META[kind];
  }

  private reload(): void {
    this.api.trash().subscribe({
      next: (entries) => {
        this.entries.set(entries);
        this.loaded.set(true);
      },
      error: () => {
        this.loaded.set(true);
        this.feedback.error('Could not load the trash — are you online?');
      },
    });
  }

  restore(entry: TrashEntry): void {
    this.busy.update((s) => new Set(s).add(entry.ref));
    this.api.restoreTrash(entry.kind, entry.ref).subscribe({
      next: () => {
        this.busy.update((s) => {
          const next = new Set(s);
          next.delete(entry.ref);
          return next;
        });
        this.entries.update((list) => list.filter((e) => !(e.kind === entry.kind && e.ref === entry.ref)));
        // Synced kinds come back through replication — pull right away so the
        // restored row is on screen when the user switches tabs.
        if (entry.kind === 'shopping') this.shoppingStore.reSync();
        if (entry.kind === 'todo') this.todoStore.reSync();
        if (entry.kind === 'wellbeing') this.wellbeingStore.reSync();
        this.feedback.notify(`Restored “${entry.name}”`);
      },
      error: (e: HttpErrorResponse) => {
        this.busy.update((s) => {
          const next = new Set(s);
          next.delete(entry.ref);
          return next;
        });
        this.feedback.error(
          e.status === 404 ? 'Already restored elsewhere.' : 'Could not restore — are you online?',
        );
        this.reload();
      },
    });
  }
}
