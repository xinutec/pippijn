import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { Alerts } from './shared/alerts';
import { LifeApi } from './life-api';
import { Me } from './models';
import { SwUpdates } from './sw-updates';
import { SyncStatus } from './sync/sync-status';

interface NavItem {
  path: string;
  icon: string;
  label: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatBadgeModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatToolbarModule,
    MatTooltipModule,
  ],
})
export class App {
  private api = inject(LifeApi);
  private swUpdates = inject(SwUpdates);
  protected readonly alerts = inject(Alerts);
  protected readonly sync = inject(SyncStatus);

  readonly me = signal<Me | null>(null);
  readonly loading = signal(true);
  readonly avatarError = signal(false);

  // The frequent destinations live in the bottom tab bar.
  readonly nav: NavItem[] = [
    { path: '/today', icon: 'today', label: 'Today' },
    { path: '/shopping', icon: 'shopping_cart', label: 'Buy' },
    { path: '/inventory', icon: 'kitchen', label: 'Inventory' },
    { path: '/recipes', icon: 'menu_book', label: 'Recipes' },
    { path: '/todo', icon: 'checklist', label: 'To-do' },
  ];

  // Less-common destinations live behind the hamburger menu.
  readonly more: NavItem[] = [
    { path: '/wellbeing', icon: 'mood', label: 'Wellbeing' },
    { path: '/house', icon: 'home', label: 'House' },
    { path: '/items', icon: 'inventory_2', label: 'All items' },
    { path: '/trash', icon: 'restore_from_trash', label: 'Recently deleted' },
    { path: '/conflicts', icon: 'compare_arrows', label: 'Sync conflicts' },
    { path: '/settings', icon: 'settings', label: 'Settings' },
  ];

  constructor() {
    this.swUpdates.start();
    this.api.me().subscribe({
      next: (m) => {
        this.me.set(m);
        this.loading.set(false);
        this.warmOfflineCache();
        this.alerts.refreshConflicts();
      },
      error: () => {
        this.me.set(null);
        this.loading.set(false);
      },
    });
  }

  // Fire the read endpoints once on login so the service worker caches them —
  // makes inventory/recipes/house viewable offline even if you went straight
  // underground without opening those tabs first. Fire-and-forget; the SW does
  // the caching, these responses are otherwise ignored.
  private warmOfflineCache(): void {
    const ignore = { error: () => {} };
    this.api.items().subscribe(ignore);
    this.api.locations().subscribe(ignore);
    this.api.recipes().subscribe(ignore);
    this.api.cookable().subscribe(ignore);
    this.api.house().subscribe(ignore);
  }

  signOut(): void {
    this.api.logout().subscribe(() => (window.location.href = '/'));
  }
}
