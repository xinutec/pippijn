import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { History, OverviewEntry, Problems, ReportDetail, ReportSummary } from './models';

/** Thin read-only client over the pulse backend. Same-origin in prod; via the
 *  dev proxy (proxy.conf.json) under `ng serve`. Ingest (POST) is producer-only
 *  and not exposed here. */
@Injectable({ providedIn: 'root' })
export class PulseApi {
  private http = inject(HttpClient);

  /** One tile per (source, collector) with its latest rollup + freshness. */
  overview(): Observable<OverviewEntry[]> {
    return this.http.get<OverviewEntry[]>('/api/overview');
  }

  /** Failing/warning checks + overdue/silent collectors — "what's wrong now". */
  problems(): Observable<Problems> {
    return this.http.get<Problems>('/api/problems');
  }

  /** Report history (runs), newest first, optionally scoped. */
  reports(source?: string, collector?: string, limit?: number): Observable<ReportSummary[]> {
    let params = new HttpParams();
    if (source) params = params.set('source', source);
    if (collector) params = params.set('collector', collector);
    if (limit) params = params.set('limit', String(limit));
    return this.http.get<ReportSummary[]>('/api/reports', { params });
  }

  /** One report with all its checks. */
  report(id: string): Observable<ReportDetail> {
    return this.http.get<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`);
  }

  /** Time series for one (source, collector, section, label) check. */
  history(source: string, collector: string, section: string, label: string): Observable<History> {
    const params = new HttpParams()
      .set('source', source)
      .set('collector', collector)
      .set('section', section)
      .set('label', label);
    return this.http.get<History>('/api/history', { params });
  }
}
