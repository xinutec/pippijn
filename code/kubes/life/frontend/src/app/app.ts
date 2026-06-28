import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { LifeApi } from './life-api';
import { Me } from './models';

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

  readonly me = signal<Me | null>(null);
  readonly loading = signal(true);

  readonly nav: NavItem[] = [
    { path: '/search', icon: 'search', label: 'Find' },
    { path: '/inventory', icon: 'kitchen', label: 'Inventory' },
    { path: '/recipes', icon: 'menu_book', label: 'Recipes' },
    { path: '/house', icon: 'home', label: 'House' },
  ];

  constructor() {
    this.api.me().subscribe({
      next: (m) => {
        this.me.set(m);
        this.loading.set(false);
      },
      error: () => {
        this.me.set(null);
        this.loading.set(false);
      },
    });
  }

  signOut(): void {
    this.api.logout().subscribe(() => (window.location.href = '/'));
  }
}
