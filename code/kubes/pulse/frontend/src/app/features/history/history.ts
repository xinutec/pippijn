import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { History as HistoryData, Verdict } from '../../models';
import { fmtValue } from '../../status';

const W = 320;
const H = 90;
const PAD = 8;

interface Dot {
  x: number;
  y: number;
  verdict: Verdict;
  value: number;
  at: string;
}
interface Tick {
  x: number;
  verdict: Verdict;
  at: string;
}
interface Chart {
  path: string;
  dots: Dot[];
  min: number;
  max: number;
}

@Component({
  selector: 'app-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MatCardModule, MatIconModule, MatProgressBarModule],
  templateUrl: './history.html',
  styleUrl: './history.scss',
})
export class History {
  // Bound from query params (withComponentInputBinding).
  readonly source = input('');
  readonly collector = input('');
  readonly section = input('');
  readonly label = input('');

  // Idle (no request) until all four params are present; otherwise fetches and
  // re-fetches whenever any of them changes.
  readonly data = httpResource<HistoryData>(() => {
    const s = this.source();
    const c = this.collector();
    const sec = this.section();
    const l = this.label();
    if (!s || !c || !sec || !l) return undefined;
    const p = new URLSearchParams({ source: s, collector: c, section: sec, label: l });
    return `/api/history?${p.toString()}`;
  });

  readonly w = W;
  readonly h = H;
  readonly fmt = fmtValue;

  /** Time-ordered verdict ticks for the full timeline strip (numeric or not). */
  readonly ticks = computed<Tick[]>(() => {
    const d = this.data.value();
    if (!d || d.points.length === 0) return [];
    const [t0, t1] = this.timeSpan(d.points.map((p) => p.collected_at));
    return d.points.map((p) => ({
      x: this.xOf(Date.parse(p.collected_at), t0, t1),
      verdict: p.verdict,
      at: p.collected_at,
    }));
  });

  /** SVG line chart over the numeric points, or null if fewer than two. */
  readonly chart = computed<Chart | null>(() => {
    const d = this.data.value();
    if (!d) return null;
    const pts = d.points.filter((p) => p.value !== null) as {
      collected_at: string;
      verdict: Verdict;
      value: number;
    }[];
    if (pts.length < 2) return null;

    const values = pts.map((p) => p.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const [t0, t1] = this.timeSpan(pts.map((p) => p.collected_at));
    const yOf = (v: number) => PAD + (1 - (v - min) / (max - min)) * (H - 2 * PAD);

    const dots: Dot[] = pts.map((p) => ({
      x: this.xOf(Date.parse(p.collected_at), t0, t1),
      y: yOf(p.value),
      verdict: p.verdict,
      value: p.value,
      at: p.collected_at,
    }));
    const path = dots
      .map((dpt, i) => `${i === 0 ? 'M' : 'L'}${dpt.x.toFixed(1)},${dpt.y.toFixed(1)}`)
      .join(' ');
    return { path, dots, min, max };
  });

  readonly latest = computed(() => {
    const pts = this.data.value()?.points ?? [];
    return pts.length ? pts[pts.length - 1] : null;
  });

  private timeSpan(times: string[]): [number, number] {
    const ms = times.map((t) => Date.parse(t));
    const t0 = Math.min(...ms);
    const t1 = Math.max(...ms);
    return [t0, t1 === t0 ? t0 + 1 : t1];
  }
  private xOf(t: number, t0: number, t1: number): number {
    return PAD + ((t - t0) / (t1 - t0)) * (W - 2 * PAD);
  }
}
