import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { Problems as ProblemsData } from '../../models';
import { PulseApi } from '../../pulse-api';
import { formatAge } from '../../status';

@Component({
  selector: 'app-problems',
  imports: [RouterLink, MatButtonModule, MatCardModule, MatIconModule, MatProgressBarModule],
  templateUrl: './problems.html',
  styleUrl: './problems.scss',
})
export class Problems {
  private api = inject(PulseApi);

  readonly data = signal<ProblemsData | null>(null);
  readonly failed = signal(false);
  readonly loading = signal(true);
  readonly formatAge = formatAge;

  readonly nothingWrong = computed(() => {
    const d = this.data();
    return !!d && d.checks.length === 0 && d.stale.length === 0;
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.failed.set(false);
    this.api.problems().subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }
}
