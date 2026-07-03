import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { OverviewEntry } from '../../models';
import { PulseApi } from '../../pulse-api';
import { formatAge, freshnessLabel, tileClass } from '../../status';

interface SourceGroup {
  source: string;
  collectors: OverviewEntry[];
}

@Component({
  selector: 'app-overview',
  imports: [RouterLink, MatButtonModule, MatCardModule, MatIconModule, MatProgressBarModule],
  templateUrl: './overview.html',
  styleUrl: './overview.scss',
})
export class Overview {
  private api = inject(PulseApi);

  readonly entries = signal<OverviewEntry[] | null>(null);
  readonly failed = signal(false);
  readonly loading = signal(true);

  readonly tileClass = tileClass;
  readonly formatAge = formatAge;
  readonly freshnessLabel = freshnessLabel;

  /** Group collectors under their source machine, source order preserved. */
  readonly groups = computed<SourceGroup[]>(() => {
    const list = this.entries();
    if (!list) return [];
    const bySource = new Map<string, OverviewEntry[]>();
    for (const e of list) {
      const arr = bySource.get(e.source) ?? [];
      arr.push(e);
      bySource.set(e.source, arr);
    }
    return [...bySource.entries()].map(([source, collectors]) => ({ source, collectors }));
  });

  /** Headline counts across every collector for the summary strip. */
  readonly summary = computed(() => {
    const list = this.entries() ?? [];
    let ok = 0;
    let problem = 0;
    for (const e of list) {
      if (e.freshness !== 'fresh' || e.fail > 0 || e.warn > 0) problem++;
      else ok++;
    }
    return { ok, problem, total: list.length };
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.failed.set(false);
    this.api.overview().subscribe({
      next: (e) => {
        this.entries.set(e);
        this.loading.set(false);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }
}
