import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { OverviewEntry } from '../../models';
import { formatAge, freshnessLabel, tileClass } from '../../status';

interface SourceGroup {
  source: string;
  collectors: OverviewEntry[];
}

@Component({
  selector: 'app-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatCardModule, MatIconModule, MatProgressBarModule],
  templateUrl: './overview.html',
  styleUrl: './overview.scss',
})
export class Overview {
  // Signal-native fetch: re-runs never (static URL) but exposes value/isLoading/
  // error/reload without a manual subscription. reload() backs the refresh button.
  readonly overview = httpResource<OverviewEntry[]>(() => '/api/overview', { defaultValue: [] });

  readonly tileClass = tileClass;
  readonly formatAge = formatAge;
  readonly freshnessLabel = freshnessLabel;

  /** Group collectors under their source machine, source order preserved. */
  readonly groups = computed<SourceGroup[]>(() => {
    const bySource = new Map<string, OverviewEntry[]>();
    for (const e of this.overview.value()) {
      const arr = bySource.get(e.source) ?? [];
      arr.push(e);
      bySource.set(e.source, arr);
    }
    return [...bySource.entries()].map(([source, collectors]) => ({ source, collectors }));
  });

  /** Headline counts across every collector for the summary strip. */
  readonly summary = computed(() => {
    let ok = 0;
    let problem = 0;
    for (const e of this.overview.value()) {
      if (e.freshness !== 'fresh' || e.fail > 0 || e.warn > 0) problem++;
      else ok++;
    }
    return { ok, problem, total: this.overview.value().length };
  });
}
