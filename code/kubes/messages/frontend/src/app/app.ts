import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatToolbarModule } from '@angular/material/toolbar';

import { firstValueFrom } from 'rxjs';

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
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  readonly me = signal<Me | null>(null);
  readonly loading = signal(true);
  readonly conversations = signal<Conversation[]>([]);

  // The URL is the source of truth for navigation state: ?origin filters the
  // list, ?chat=<origin>:<id> opens a conversation. Deriving from the route
  // means deep-links, refresh, and the browser Back button all just work.
  private params = toSignal(this.route.queryParamMap);

  readonly originFilter = computed<Origin | 'all'>(() => {
    const o = this.params()?.get('origin');
    return o === 'signal' || o === 'gchat' ? o : 'all';
  });

  private selectedKey = computed(() => this.params()?.get('chat') ?? null);

  readonly selected = computed<Conversation | null>(() => {
    const key = this.selectedKey();
    if (!key) return null;
    const i = key.indexOf(':'); // ids contain ':' (dm:uuid, group:…) → split once
    if (i < 0) return null;
    const origin = key.slice(0, i);
    const id = key.slice(i + 1);
    return this.conversations().find((c) => c.origin === origin && c.id === id) ?? null;
  });

  readonly messages = signal<Message[]>([]);
  readonly loadingThread = signal(false);
  readonly loadingOlder = signal(false);
  readonly hasMore = signal(false);
  readonly threadError = signal(false);
  private cursor: number | null = null;

  // Search overlays the list; it's transient UI, not URL state.
  readonly query = signal('');
  readonly results = signal<SearchHit[] | null>(null);
  readonly searching = signal(false);

  readonly visibleConversations = computed(() => {
    const f = this.originFilter();
    const list = this.conversations();
    return f === 'all' ? list : list.filter((c) => c.origin === f);
  });

  /** Messages bucketed by calendar day, so each day renders as a section with a
   *  sticky date header (the header pins only within its own day → it shows the
   *  current top message's date and is replaced by the next day, never stacks). */
  readonly dayGroups = computed(() => {
    const groups: { key: string; ts: number; items: Message[] }[] = [];
    let lastKey: string | null = null;
    for (const m of this.messages()) {
      const key = new Date(m.ts).toDateString();
      if (key === lastKey) {
        groups[groups.length - 1].items.push(m);
      } else {
        groups.push({ key, ts: m.ts, items: [m] });
        lastKey = key;
      }
    }
    return groups;
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

    // Load (or clear) the thread whenever the URL's selected conversation
    // changes — including Back/forward and a deep-link once conversations load.
    let loadedKey: string | null = null;
    effect(() => {
      const key = this.selectedKey();
      const conv = this.selected();
      if (key === loadedKey) return; // already handled this target
      if (key && !conv) return; // chat set but conversations not loaded yet — wait
      loadedKey = key;
      if (conv) void this.loadThread(conv);
      else this.messages.set([]);
    });
  }

  setFilter(f: Origin | 'all'): void {
    this.navigate({ origin: f === 'all' ? null : f });
  }

  /** Open a conversation = put it in the URL; the effect loads it. Clears ?from
   *  so a freshly-opened conversation starts at the most recent page. */
  open(c: Conversation): void {
    this.navigate({ chat: `${c.origin}:${c.id}`, from: null });
  }

  /** Back to the list = drop ?chat (and ?from) — the in-app/mobile back. */
  back(): void {
    this.navigate({ chat: null, from: null });
  }

  private navigate(queryParams: Record<string, string | null>): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge' });
  }

  /** Load the thread, restoring the paged-back depth from ?from (the oldest ts
   *  the user had loaded) so a refresh/deep-link shows the same range, not just
   *  the most recent page. */
  private async loadThread(c: Conversation): Promise<void> {
    this.messages.set([]);
    this.threadError.set(false);
    this.hasMore.set(false);
    this.cursor = null;
    this.loadingThread.set(true);
    const from = Number(this.route.snapshot.queryParamMap.get('from')) || null;
    try {
      const first = await firstValueFrom(this.api.messages(c.origin, c.id, undefined, PAGE));
      let msgs = first.messages;
      let hasMore = first.has_more;
      let cursor = first.next_before;
      // Page older until we've reached the saved depth (or run out).
      while (from != null && hasMore && cursor != null && msgs.length > 0 && msgs[0].ts > from) {
        const older = await firstValueFrom(this.api.messages(c.origin, c.id, cursor, PAGE));
        if (older.messages.length === 0) break;
        msgs = [...older.messages, ...msgs];
        hasMore = older.has_more;
        cursor = older.next_before;
      }
      this.messages.set(msgs);
      this.hasMore.set(hasMore);
      this.cursor = cursor;
      this.loadingThread.set(false);
    } catch {
      this.threadError.set(true);
      this.loadingThread.set(false);
    }
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
        // Persist how far back we've paged so a refresh restores it. replaceUrl:
        // paging shouldn't add Back-history (Back should leave the conversation).
        const oldest = this.messages()[0]?.ts;
        if (oldest != null) {
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: { from: String(oldest) },
            queryParamsHandling: 'merge',
            replaceUrl: true,
          });
        }
      },
      error: () => this.loadingOlder.set(false),
    });
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

  signOut(): void {
    this.api.logout().subscribe(() => (window.location.href = '/'));
  }
}
