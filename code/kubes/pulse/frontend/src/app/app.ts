import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

import { BUILD_INFO } from './build-info';
import { Problems } from './models';

const EMPTY_PROBLEMS: Problems = { checks: [], stale: [] };

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly build = BUILD_INFO;

  // Standing badge on the Problems tab: how many issues are open right now
  // (failing/warning checks + overdue/silent collectors). Default-valued so the
  // badge stays hidden (count 0) while loading or on error.
  private problems = httpResource<Problems>(() => '/api/problems', {
    defaultValue: EMPTY_PROBLEMS,
  });
  readonly problemCount = computed(
    () => this.problems.value().checks.length + this.problems.value().stale.length,
  );

  // The nav is a bottom tab bar on phones, a left rail from tablet up.
  readonly tabs = signal([
    { path: '/', exact: true, icon: 'dashboard', label: 'Overview' },
    { path: '/problems', exact: false, icon: 'warning', label: 'Problems' },
  ]);
}
