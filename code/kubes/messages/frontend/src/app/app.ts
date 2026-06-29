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
import { Conversation, Me, Message, Origin } from './models';

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
  readonly selected = signal<Conversation | null>(null);
  readonly messages = signal<Message[]>([]);
  readonly loadingThread = signal(false);

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
    this.loadingThread.set(true);
    this.api.messages(c.origin, c.id).subscribe({
      next: (page) => {
        this.messages.set(page.messages);
        this.loadingThread.set(false);
      },
      error: () => this.loadingThread.set(false),
    });
  }

  title(c: Conversation): string {
    return c.name?.trim() || (c.kind === 'dm' ? 'Direct message' : 'Group');
  }

  signOut(): void {
    this.api.logout().subscribe(() => (window.location.href = '/'));
  }
}
