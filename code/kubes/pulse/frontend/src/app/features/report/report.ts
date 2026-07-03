import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { CheckOut, ReportDetail } from '../../models';

interface Section {
  name: string;
  checks: CheckOut[];
}

@Component({
  selector: 'app-report',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, MatCardModule, MatIconModule, MatProgressBarModule],
  templateUrl: './report.html',
  styleUrl: './report.scss',
})
export class Report {
  /** Bound from the :id route param (withComponentInputBinding). */
  readonly id = input.required<string>();

  // Reads id() in the request factory, so the resource re-fetches whenever the
  // route id changes — no manual effect/subscription.
  readonly detail = httpResource<ReportDetail>(
    () => `/api/reports/${encodeURIComponent(this.id())}`,
  );

  /** Checks grouped under their section header, in report order. */
  readonly sections = computed<Section[]>(() => {
    const d = this.detail.value();
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
}
