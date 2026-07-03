import { ChangeDetectionStrategy, Component, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { Problems as ProblemsData } from '../../models';
import { formatAge } from '../../status';

const EMPTY: ProblemsData = { checks: [], stale: [] };

@Component({
  selector: 'app-problems',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatCardModule, MatIconModule, MatProgressBarModule],
  templateUrl: './problems.html',
  styleUrl: './problems.scss',
})
export class Problems {
  readonly data = httpResource<ProblemsData>(() => '/api/problems', { defaultValue: EMPTY });
  readonly formatAge = formatAge;

  readonly nothingWrong = computed(() => {
    const d = this.data.value();
    return !this.data.isLoading() && d.checks.length === 0 && d.stale.length === 0;
  });
}
