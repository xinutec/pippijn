import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { CheckOut, ReportDetail } from '../../models';
import { PulseApi } from '../../pulse-api';

interface Section {
  name: string;
  checks: CheckOut[];
}

@Component({
  selector: 'app-report',
  imports: [RouterLink, DatePipe, MatCardModule, MatIconModule, MatProgressBarModule],
  templateUrl: './report.html',
  styleUrl: './report.scss',
})
export class Report {
  private api = inject(PulseApi);

  /** Bound from the :id route param (withComponentInputBinding). */
  readonly id = input.required<string>();

  readonly detail = signal<ReportDetail | null>(null);
  readonly failed = signal(false);
  readonly loading = signal(true);

  /** Checks grouped under their section header, in report order. */
  readonly sections = computed<Section[]>(() => {
    const d = this.detail();
    if (!d) return [];
    const order: string[] = [];
    const bySection = new Map<string, CheckOut[]>();
    for (const c of d.checks) {
      if (!bySection.has(c.section)) {
        bySection.set(c.section, []);
        order.push(c.section);
      }
      bySection.get(c.section)!.push(c);
    }
    return order.map((name) => ({ name, checks: bySection.get(name)! }));
  });

  constructor() {
    // Reload whenever the route id changes.
    effect(() => {
      const id = this.id();
      this.loading.set(true);
      this.failed.set(false);
      this.detail.set(null);
      this.api.report(id).subscribe({
        next: (d) => {
          this.detail.set(d);
          this.loading.set(false);
        },
        error: () => {
          this.failed.set(true);
          this.loading.set(false);
        },
      });
    });
  }
}
