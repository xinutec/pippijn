import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatBottomSheet, MatBottomSheetModule } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';

import { ExpiryInfo, expiryInfo } from '../../expiry';
import { Feedback } from '../../shared/feedback';
import { LifeApi } from '../../life-api';
import { Item } from '../../models';
import { WellbeingCheckin } from '../../shared/wellbeing-checkin';
import { ShoppingDoc, ShoppingStore } from '../../sync/shopping-store';
import { TodoDoc, TodoStore } from '../../sync/todo-store';
import { prioRank } from '../todo/todo-meta';
import { TodoDetail } from '../todo/todo-detail';
import { TodoGraph, Urgency } from '../todo/todo-graph';

/** One to-do surfaced on Today, with a short reason chip. */
interface Attention {
  todo: TodoDoc;
  chip: { label: string; cls: string } | null;
}

const URGENCY_RANK: Record<Urgency, number> = { overdue: 0, today: 1, soon: 2, none: 3 };

/** The landing screen: "what needs me right now?" — a wellbeing check-in, the
 *  to-dos that are overdue/due/ready, food about to expire, and quick jumps.
 *  Pure composition over the existing stores/APIs; no new backend. */
@Component({
  selector: 'app-today',
  templateUrl: './today.html',
  styleUrl: './today.scss',
  imports: [
    RouterLink,
    MatBottomSheetModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatIconModule,
    MatListModule,
    WellbeingCheckin,
  ],
})
export class Today {
  private api = inject(LifeApi);
  private shopping = inject(ShoppingStore);
  private todos = inject(TodoStore);
  private graph = inject(TodoGraph);
  private sheet = inject(MatBottomSheet);
  private feedback = inject(Feedback);

  private readonly items = signal<Item[]>([]);
  private readonly shoppingItems = toSignal(this.shopping.items$, {
    initialValue: [] as ShoppingDoc[],
  });

  constructor() {
    this.api.items().subscribe({ next: (i) => this.items.set(i), error: () => {} });
  }

  /** The to-dos worth surfacing: anything overdue / due / due-soon, or "ready"
   *  (unblocked with met dependencies). Blocked and waiting ones are excluded —
   *  you can't act on them now. Capped; the full list is one tap away. */
  readonly attention = computed<Attention[]>(() => {
    return this.graph
      .todoItems()
      .filter((t) => t.status !== 'done')
      .map((todo) => ({ todo, state: this.graph.statusOf(todo), urgency: this.graph.urgencyOf(todo) }))
      .filter((x) => x.state !== 'waiting' && x.state !== 'blocked')
      .filter((x) => x.urgency !== 'none' || x.state === 'ready')
      .sort(
        (a, b) =>
          URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
          prioRank(a.todo.priority) - prioRank(b.todo.priority) ||
          (a.todo.due ?? '9999-99-99').localeCompare(b.todo.due ?? '9999-99-99'),
      )
      .slice(0, 5)
      .map((x) => ({ todo: x.todo, chip: this.chip(x.todo, x.urgency) }));
  });

  /** Food that's expired or expiring within 3 days, soonest first. */
  readonly expiring = computed(() => {
    return this.items()
      .flatMap((item) => (item.expiry ? [{ item, expiry: item.expiry, info: expiryInfo(item.expiry) }] : []))
      .filter((x) => x.info.cls !== 'ok')
      .sort((a, b) => a.expiry.localeCompare(b.expiry))
      .slice(0, 5);
  });

  readonly buyCount = computed(() => this.shoppingItems().filter((i) => !i.done).length);

  /** Tick a to-do off right from Today (rows here are never blocked — the
   *  attention filter excludes those). Undo puts it back. */
  complete(todo: TodoDoc): void {
    void this.todos.setStatus(todo.ulid, 'done');
    this.feedback.undo(`Done: ${todo.title}`, () => void this.todos.setStatus(todo.ulid, 'open'));
  }

  /** Tap the title: the full to-do editor, same as in the list. */
  open(todo: TodoDoc): void {
    this.sheet.open(TodoDetail, { data: { ulid: todo.ulid } });
  }

  private chip(todo: TodoDoc, urgency: Urgency): { label: string; cls: string } | null {
    if (urgency !== 'none' && todo.due) {
      const d = this.graph.daysUntil(todo.due);
      if (urgency === 'overdue') return { label: d === -1 ? 'overdue 1d' : `overdue ${-d}d`, cls: 'overdue' };
      if (urgency === 'today') return { label: 'due today', cls: 'overdue' };
      return { label: d === 1 ? 'due tomorrow' : `due in ${d}d`, cls: 'due-soon' };
    }
    return { label: 'ready', cls: 'ready' };
  }

  expiryOf(expiry: string): ExpiryInfo {
    return expiryInfo(expiry);
  }
}
