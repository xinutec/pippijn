import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { App } from './app';
import { MessagesApi } from './messages-api';
import { Conversation, Me, Message, MessagesPage, SearchHit } from './models';

function msg(id: string, ts: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    ts,
    sender: 's',
    is_outgoing: false,
    body: 'b',
    deleted: false,
    edited: false,
    reactions: [],
    attachments: [],
    ...extra,
  };
}

const CONVS: Conversation[] = [
  { origin: 'signal', id: 'dm:a', name: 'Alice', kind: 'dm', message_count: 5, last_ts: 200 },
  { origin: 'gchat', id: 'gc1', name: 'Bob', kind: 'dm', message_count: 3, last_ts: 300 },
];

const ME: Me = { user_id: 'pippijn', display_name: 'Pippijn' };

interface ApiOverrides {
  messages?: ReturnType<typeof vi.fn>;
  search?: ReturnType<typeof vi.fn>;
}

function makeApi(over: ApiOverrides = {}) {
  return {
    me: vi.fn(() => of(ME)),
    conversations: vi.fn(() => of(CONVS)),
    messages: over.messages ?? vi.fn(() => of({ messages: [msg('1', 100)], has_more: false, next_before: null } as MessagesPage)),
    search: over.search ?? vi.fn(() => of([] as SearchHit[])),
    logout: vi.fn(() => of({})),
  } as unknown as MessagesApi;
}

function setup(api: MessagesApi): App {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: MessagesApi, useValue: api }],
  });
  // Instantiate the component class (runs the constructor → loads me +
  // conversations). We test the class logic, not the rendered DOM.
  return TestBed.runInInjectionContext(() => new App());
}

describe('App', () => {
  it('loads the user and conversations on init', () => {
    const app = setup(makeApi());
    expect(app.me()?.user_id).toBe('pippijn');
    expect(app.conversations().length).toBe(2);
  });

  it('filters conversations by origin', () => {
    const app = setup(makeApi());
    expect(app.visibleConversations().length).toBe(2);
    app.setFilter('signal');
    expect(app.visibleConversations().map((c) => c.id)).toEqual(['dm:a']);
    app.setFilter('gchat');
    expect(app.visibleConversations().map((c) => c.id)).toEqual(['gc1']);
  });

  it('opens a conversation and records the pagination cursor', () => {
    const messages = vi.fn(() =>
      of({ messages: [msg('2', 100)], has_more: true, next_before: 100 } as MessagesPage),
    );
    const app = setup(makeApi({ messages }));
    app.open(CONVS[0]);
    expect(app.selected()).toBe(CONVS[0]);
    expect(app.messages().map((m) => m.id)).toEqual(['2']);
    expect(app.hasMore()).toBe(true);
    expect(messages).toHaveBeenCalledWith('signal', 'dm:a', undefined, 100);
  });

  it('loadOlder prepends the older page and advances the cursor', () => {
    // First page (newest) has more; second page (older) ends it.
    const messages = vi
      .fn()
      .mockReturnValueOnce(of({ messages: [msg('2', 100)], has_more: true, next_before: 100 } as MessagesPage))
      .mockReturnValueOnce(of({ messages: [msg('1', 50)], has_more: false, next_before: null } as MessagesPage));
    const app = setup(makeApi({ messages }));
    app.open(CONVS[0]);
    app.loadOlder();
    expect(app.messages().map((m) => m.id)).toEqual(['1', '2']); // older prepended
    expect(app.hasMore()).toBe(false);
    expect(messages).toHaveBeenLastCalledWith('signal', 'dm:a', 100, 100); // before=cursor
  });

  it('does not page when there is nothing older', () => {
    const messages = vi.fn(() =>
      of({ messages: [msg('1', 100)], has_more: false, next_before: null } as MessagesPage),
    );
    const app = setup(makeApi({ messages }));
    app.open(CONVS[0]);
    app.loadOlder();
    expect(messages).toHaveBeenCalledTimes(1); // open only; loadOlder no-op
  });

  it('runs a search and clears it', () => {
    const hit: SearchHit = { origin: 'signal', conversation_id: 'dm:a', conversation_name: 'Alice', ts: 1, sender: 's', snippet: 'hi' };
    const search = vi.fn(() => of([hit]));
    const app = setup(makeApi({ search }));
    app.query.set('hi');
    app.runSearch();
    expect(app.results()).toEqual([hit]);
    app.clearSearch();
    expect(app.results()).toBeNull();
    expect(app.query()).toBe('');
  });

  it('ignores a blank search', () => {
    const search = vi.fn(() => of([] as SearchHit[]));
    const app = setup(makeApi({ search }));
    app.query.set('   ');
    app.runSearch();
    expect(search).not.toHaveBeenCalled();
    expect(app.results()).toBeNull();
  });

  it('opens the conversation a search hit belongs to', () => {
    const messages = vi.fn(() => of({ messages: [msg('1', 100)], has_more: false, next_before: null } as MessagesPage));
    const app = setup(makeApi({ messages }));
    app.openHit({ origin: 'gchat', conversation_id: 'gc1', conversation_name: 'Bob', ts: 1, sender: 's', snippet: 'x' });
    expect(app.selected()?.id).toBe('gc1');
    expect(messages).toHaveBeenCalledWith('gchat', 'gc1', undefined, 100);
  });

  it('newDay marks day boundaries', () => {
    const app = setup(makeApi());
    // Local-component dates so the test is timezone-independent (newDay groups
    // by local calendar day, matching how messages render).
    const d1 = new Date(2026, 5, 1, 9, 0, 0).getTime();
    const d1b = new Date(2026, 5, 1, 18, 0, 0).getTime();
    const d2 = new Date(2026, 5, 2, 9, 0, 0).getTime();
    expect(app.newDay(undefined, msg('a', d1))).toBe(true);
    expect(app.newDay(msg('a', d1), msg('b', d1b))).toBe(false);
    expect(app.newDay(msg('a', d1b), msg('b', d2))).toBe(true);
  });

  it('title falls back when a conversation is unnamed', () => {
    const app = setup(makeApi());
    expect(app.title({ ...CONVS[0], name: null })).toBe('Direct message');
    expect(app.title({ ...CONVS[0], name: '', kind: 'group' })).toBe('Group');
    expect(app.title(CONVS[0])).toBe('Alice');
  });
});
