import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatToolbarModule } from '@angular/material/toolbar';

import { MessagesApi } from './messages-api';
import { Conversation, Me, Message, Origin, SearchHit } from './models';

const PAGE = 100;

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  imports: [
    DatePipe,
    FormsModule,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
  ],
})
export class App {
  private api = inject(MessagesApi);

  readonly me = signal<Me | null>(null);
  readonly loading = signal(true);

  readonly conversations = signal<Conversation[]>([]);
  readonly originFilter = signal<Origin | 'all'>('all');

  // Thread state.
  readonly selected = signal<Conversation | null>(null);
  readonly messages = signal<Message[]>([]);
  readonly loadingThread = signal(false);
  readonly loadingOlder = signal(false);
  readonly hasMore = signal(false);
  readonly threadError = signal(false);
  private cursor: number | null = null;

  // Search state. `results === null` → showing the conversation list.
  readonly query = signal('');
  readonly results = signal<SearchHit[] | null>(null);
  readonly searching = signal(false);

  readonly visibleConversations = computed(() => {
    const f = this.originFilter();
    const list = this.conversations();
    return f === 'all' ? list : list.filter((c) => c.origin === f);
  });

  constructor() {
    this.api.me().subscribe({
      next: (m) => {
        this.me.set(m);
        this.loading.set(false);
        this.api.conversations().subscribe((cs) => this.conversations.set(cs));
      },
      error: () => {
        this.me.set(null);
        this.loading.set(false);
      },
    });
  }

  setFilter(f: Origin | 'all'): void {
    this.originFilter.set(f);
  }

  open(c: Conversation): void {
    this.selected.set(c);
    this.messages.set([]);
    this.threadError.set(false);
    this.hasMore.set(false);
    this.cursor = null;
    this.loadingThread.set(true);
    this.api.messages(c.origin, c.id, undefined, PAGE).subscribe({
      next: (page) => {
        this.messages.set(page.messages);
        this.hasMore.set(page.has_more);
        this.cursor = page.next_before;
        this.loadingThread.set(false);
      },
      error: () => {
        this.threadError.set(true);
        this.loadingThread.set(false);
      },
    });
  }

  loadOlder(): void {
    const c = this.selected();
    if (!c || !this.hasMore() || this.cursor == null || this.loadingOlder()) return;
    this.loadingOlder.set(true);
    this.api.messages(c.origin, c.id, this.cursor, PAGE).subscribe({
      next: (page) => {
        this.messages.update((cur) => [...page.messages, ...cur]); // prepend older
        this.hasMore.set(page.has_more);
        this.cursor = page.next_before;
        this.loadingOlder.set(false);
      },
      error: () => this.loadingOlder.set(false),
    });
  }

  /** Mobile: return from the thread to the conversation list. */
  back(): void {
    this.selected.set(null);
  }

  runSearch(): void {
    const q = this.query().trim();
    if (!q) {
      this.results.set(null);
      return;
    }
    this.searching.set(true);
    this.api.search(q).subscribe({
      next: (hits) => {
        this.results.set(hits);
        this.searching.set(false);
      },
      error: () => {
        this.results.set([]);
        this.searching.set(false);
      },
    });
  }

  clearSearch(): void {
    this.query.set('');
    this.results.set(null);
  }

  /** Open the conversation a search hit belongs to (looked up from the list). */
  openHit(h: SearchHit): void {
    const c = this.conversations().find((x) => x.origin === h.origin && x.id === h.conversation_id);
    if (c) this.open(c);
  }

  title(c: Conversation): string {
    // Empty/whitespace name → kind-based fallback. An explicit length check (not
    // `||`/`??`/`x?x:y`) makes the empty-string-is-no-name intent unambiguous.
    const name = c.name?.trim() ?? '';
    return name.length > 0 ? name : c.kind === 'dm' ? 'Direct message' : 'Group';
  }

  /** True when message `cur` falls on a different calendar day than `prev`. */
  newDay(prev: Message | undefined, cur: Message): boolean {
    if (!prev) return true;
    return new Date(prev.ts).toDateString() !== new Date(cur.ts).toDateString();
  }

  signOut(): void {
    this.api.logout().subscribe(() => (window.location.href = '/'));
  }
}
