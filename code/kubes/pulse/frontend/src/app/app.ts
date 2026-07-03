import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { catchError, of } from 'rxjs';

import { BUILD_INFO } from './build-info';
import { PulseApi } from './pulse-api';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private api = inject(PulseApi);

  readonly build = BUILD_INFO;

  // A small standing badge on the Problems tab: how many issues are open right
  // now (failing/warning checks + overdue/silent collectors). Loaded once at
  // startup; the Problems/Overview views refresh their own data on demand.
  private problems = toSignal(this.api.problems().pipe(catchError(() => of(null))), {
    initialValue: null,
  });
  readonly problemCount = computed(() => {
    const p = this.problems();
    if (!p) return 0;
    return p.checks.length + p.stale.length;
  });

  // The nav is a bottom tab bar on phones, a left rail from tablet up.
  readonly tabs = signal([
    { path: '/', exact: true, icon: 'dashboard', label: 'Overview' },
    { path: '/problems', exact: false, icon: 'warning', label: 'Problems' },
  ]);
}
