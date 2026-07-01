import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { LifeApi } from './life-api';
import { Me } from './models';
import { SwUpdates } from './sw-updates';

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
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
  ],
})
export class App {
  private api = inject(LifeApi);
  private swUpdates = inject(SwUpdates);

  readonly me = signal<Me | null>(null);
  readonly loading = signal(true);
  readonly avatarError = signal(false);

  // The frequent destinations live in the bottom tab bar.
  readonly nav: NavItem[] = [
    { path: '/search', icon: 'search', label: 'Find' },
    { path: '/shopping', icon: 'shopping_cart', label: 'Buy' },
    { path: '/inventory', icon: 'kitchen', label: 'Inventory' },
    { path: '/recipes', icon: 'menu_book', label: 'Recipes' },
    { path: '/todo', icon: 'checklist', label: 'To-do' },
  ];

  // Less-common destinations live behind the hamburger menu.
  readonly more: NavItem[] = [
    { path: '/house', icon: 'home', label: 'House' },
    { path: '/items', icon: 'inventory_2', label: 'All items' },
    { path: '/settings', icon: 'settings', label: 'Settings' },
  ];

  constructor() {
    this.swUpdates.start();
    this.api.me().subscribe({
      next: (m) => {
        this.me.set(m);
        this.loading.set(false);
        this.warmOfflineCache();
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
