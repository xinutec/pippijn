import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { firstValueFrom } from 'rxjs';

import { MessagesApi } from './messages-api';
import { MessagesStore } from './messages-store';
import { Conversation, Message, Origin } from './models';

const PAGE = 100;

@Component({
  selector: 'app-thread',
  templateUrl: './thread.html',
  styleUrl: './thread.scss',
  // The host IS the scroll container (class `thread`), so the day headers' sticky
  // pinning and the scroll-position restore work against it.
  host: { class: 'thread' },
  imports: [DatePipe, MatButtonModule, MatIconModule, MatProgressBarModule],
})
export class Thread {
  private api = inject(MessagesApi);
  private store = inject(MessagesStore);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  // Bound from the route (withComponentInputBinding); both absent on `/` → the
  // placeholder. Ids can contain ':' and '/'; the router encodes/decodes them.
  // Our navigation only ever routes valid origins, so `origin` is typed as such.
  readonly origin = input<Origin>();
  readonly id = input<string>();

  // A conversation is routed (vs the '' placeholder route) when both params are
  // bound. Kept as a boolean so the template doesn't compare signals to null.
  readonly routed = computed(() => this.origin() != null && this.id() != null);

  readonly conversation = computed<Conversation | null>(() => {
    const o = this.origin();
    const i = this.id();
    return o != null && i != null ? this.store.find(o, i) : null;
  });

  // Title from the loaded list when available; a deep link can render the thread
  // before the list arrives, so fall back rather than block.
  readonly headTitle = computed(() => {
    const c = this.conversation();
    return c ? this.store.title(c) : 'Conversation';
  });

  readonly messages = signal<Message[]>([]);
  readonly loadingThread = signal(false);
  readonly loadingOlder = signal(false);
  readonly hasMore = signal(false);
  readonly threadError = signal(false);
  private cursor: number | null = null;

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
    // (Re)load whenever the routed conversation changes — deep link, switching
    // conversations (Angular reuses this instance, just updates the inputs),
    // Back/forward.
    let loadedKey: string | null = null;
    effect(() => {
      const o = this.origin();
      const i = this.id();
      const key = o != null && i != null ? `${o}:${i}` : null;
      if (key === loadedKey) return;
      loadedKey = key;
      if (o != null && i != null) void this.loadThread(o, i);
      else this.messages.set([]);
    });
  }

  /** Load the thread, restoring the paged-back depth from ?from (the oldest ts
   *  the user had loaded) so a refresh/deep-link shows the same range. */
  private async loadThread(origin: Origin, id: string): Promise<void> {
    this.messages.set([]);
    this.threadError.set(false);
    this.hasMore.set(false);
    this.cursor = null;
    this.loadingThread.set(true);
    const from = Number(this.route.snapshot.queryParamMap.get('from')) || null;
    try {
      const first = await firstValueFrom(this.api.messages(origin, id, undefined, PAGE));
      let msgs = first.messages;
      let hasMore = first.has_more;
      let cursor = first.next_before;
      // Page older until we've reached the saved depth (or run out).
      while (from != null && hasMore && cursor != null && msgs.length > 0 && msgs[0].ts > from) {
        const older = await firstValueFrom(this.api.messages(origin, id, cursor, PAGE));
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

  reload(): void {
    const o = this.origin();
    const i = this.id();
    if (o != null && i != null) void this.loadThread(o, i);
  }

  loadOlder(): void {
    const o = this.origin();
    const i = this.id();
    if (o == null || i == null || !this.hasMore() || this.cursor == null || this.loadingOlder()) return;
    this.loadingOlder.set(true);
    this.api.messages(o, i, this.cursor, PAGE).subscribe({
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

  /** In-app back (the mobile single-pane control) = return to the list route,
   *  keeping the origin filter and dropping the paged depth. */
  back(): void {
    void this.router.navigate(['/'], { queryParams: { from: null }, queryParamsHandling: 'merge' });
  }
}
