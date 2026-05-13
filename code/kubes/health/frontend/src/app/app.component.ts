import { AfterViewInit, Component, ElementRef, OnInit, effect, inject, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { MatToolbarModule } from "@angular/material/toolbar";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatTabsModule } from "@angular/material/tabs";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import {
  HealthService,
  type ActivityDay, type SleepLog, type SleepStage, type HeartRatePoint, type VelocityData,
} from "./services/health.service";
import { ReauthBannerComponent } from "./components/reauth-banner/reauth-banner.component";
import { SummaryCardsComponent } from "./components/summary-cards/summary-cards.component";
import { HypnogramComponent } from "./components/hypnogram/hypnogram.component";
import { IntradayHrComponent } from "./components/intraday-hr/intraday-hr.component";
import { SpeedChartComponent } from "./components/speed-chart/speed-chart.component";
import { TimelineComponent } from "./components/timeline/timeline.component";
import { StepsChartComponent } from "./components/steps-chart/steps-chart.component";
import { HeartrateChartComponent } from "./components/heartrate-chart/heartrate-chart.component";
import { SleepChartComponent } from "./components/sleep-chart/sleep-chart.component";
import { formatDateInTz, browserTimezone, todayLocal } from "./time-utils";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    MatToolbarModule, MatButtonModule, MatIconModule, MatTabsModule, MatProgressSpinnerModule,
    ReauthBannerComponent,
    SummaryCardsComponent, HypnogramComponent, IntradayHrComponent, SpeedChartComponent, TimelineComponent,
    StepsChartComponent, HeartrateChartComponent, SleepChartComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, AfterViewInit {
  readonly view = signal<"today" | "trends">("today");
  readonly selectedDate = signal(todayLocal());
  readonly activity = signal<ActivityDay[]>([]);
  readonly sleep = signal<SleepLog[]>([]);
  readonly sleepStages = signal<SleepStage[]>([]);
  readonly intradayHr = signal<HeartRatePoint[]>([]);
  readonly velocity = signal<VelocityData | null>(null);
  readonly latestActivity = signal<ActivityDay | null>(null);
  readonly latestSleep = signal<SleepLog | null>(null);
  readonly authenticated = signal(false);
  readonly fitbitLinked = signal(false);
  readonly loading = signal(true);
  readonly dayLoading = signal(false);

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly host = inject(ElementRef<HTMLElement>);

  constructor(readonly health: HealthService) {
    // Diagnostic: stream dayLoading state changes to the pod logs so
    // we can correlate them with the ResizeObserver events below.
    // Also retry the observer install on every signal change — the
    // tab-group only enters the DOM once `loading()` flips false,
    // which is after the constructor and even ngAfterViewInit run.
    effect(() => {
      const loading = this.dayLoading();
      void this.health.clientLog("day-loading-change", { loading });
      this.tryInstallObservers();
    });
    effect(() => {
      // Cheap re-trigger: any change to top-level signals retries.
      void this.loading();
      void this.fitbitLinked();
      void this.authenticated();
      this.tryInstallObservers();
    });
  }

  ngAfterViewInit(): void {
    this.tryInstallObservers();
  }

  private observersInstalled = false;

  /** Lazy-install ResizeObservers on .day-nav / .tab-content /
   *  .day-label once those elements exist in the DOM. The elements
   *  live inside the mat-tab-group, which only renders after the
   *  initial `loading()` flips to false. We retry on every signal
   *  change until installation succeeds, then mark
   *  `observersInstalled` so retries become no-ops.
   *
   *  Each ResizeObserver posts dimensions to /api/client-log so the
   *  layout-instability investigation can be driven from pod logs
   *  rather than a browser inspector. Remove the install once the
   *  cause is identified; the endpoint + helper stay. */
  private tryInstallObservers(): void {
    if (this.observersInstalled) return;
    // Defer to a microtask so Angular has finished the current
    // change-detection cycle and the freshly-rendered DOM is
    // queryable.
    queueMicrotask(() => {
      if (this.observersInstalled) return;
      const root = this.host.nativeElement;
      const targets: Array<[string, string]> = [
        [".day-nav", "day-nav"],
        [".tab-content", "tab-content"],
        [".day-label", "day-label"],
      ];
      const elements: Array<[HTMLElement, string]> = [];
      for (const [selector, tag] of targets) {
        const el = root.querySelector(selector) as HTMLElement | null;
        if (!el) return; // wait for next retry
        elements.push([el, tag]);
      }
      for (const [el, tag] of elements) {
        new ResizeObserver(() => {
          const r = el.getBoundingClientRect();
          const payload: Record<string, unknown> = {
            w: Math.round(r.width),
            h: Math.round(r.height),
            ts: Date.now(),
          };
          // For the day-label specifically, also dump innerHTML and
          // a few computed styles so we can see WHY the height grows
          // during dayLoading. innerHTML is capped because we don't
          // need huge payloads on stdout. Bracket notation because
          // Angular's production build enforces TS4111
          // (noPropertyAccessFromIndexSignature) on Record types.
          if (tag === "day-label") {
            const cs = window.getComputedStyle(el);
            payload["text"] = el.textContent?.slice(0, 100) ?? "";
            payload["html"] = el.innerHTML.slice(0, 200);
            payload["display"] = cs.display;
            payload["lineHeight"] = cs.lineHeight;
            payload["padding"] = cs.padding;
            payload["flexDirection"] = cs.flexDirection;
            payload["fontSize"] = cs.fontSize;
            payload["whiteSpace"] = cs.whiteSpace;
            payload["childCount"] = el.children.length;
          }
          void this.health.clientLog(`${tag}-resize`, payload);
        }).observe(el);
      }
      this.observersInstalled = true;
      void this.health.clientLog("observers-installed", {});
    });
  }

  /** Validate a ?date=YYYY-MM-DD query parameter. Rejects malformed
   *  strings and future dates (the timeline doesn't render future days). */
  private parseDateParam(raw: string | null): string | null {
    if (raw === null) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    if (raw > todayLocal()) return null;
    return raw;
  }

  /** Sync `selectedDate` into the URL as `?date=`. Omits the parameter
   *  for today so the canonical URL stays clean. Replaces history so a
   *  single reload doesn't pile up entries; left/right navigation pushes
   *  a new entry so back/forward work as expected. */
  private writeDateToUrl(date: string, push: boolean): void {
    const queryParams = date === todayLocal() ? { date: null } : { date };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: "merge",
      replaceUrl: !push,
    });
  }

  async ngOnInit(): Promise<void> {
    const ok = await this.health.checkAuth();
    this.authenticated.set(ok);
    if (!ok) { this.loading.set(false); return; }

    this.fitbitLinked.set(this.health.user()?.fitbitLinked ?? false);
    if (!this.fitbitLinked()) { this.loading.set(false); return; }

    // Restore the day from `?date=YYYY-MM-DD` on first paint so reload
    // stays on the day the user navigated to.
    const initial = this.parseDateParam(this.route.snapshot.queryParamMap.get("date"));
    if (initial !== null) this.selectedDate.set(initial);

    // Browser back/forward: when the user changes the URL externally
    // (history nav, hand-edit), sync the in-app state.
    this.route.queryParamMap.subscribe(async (params) => {
      const next = this.parseDateParam(params.get("date")) ?? todayLocal();
      if (next === this.selectedDate()) return;
      this.selectedDate.set(next);
      this.dayLoading.set(true);
      await this.loadData();
      this.dayLoading.set(false);
    });

    // Fire-and-forget: keep PhoneTrack's visualisation filter aligned with
    // "today from 00:00 (or yesterday after midnight before 06:00)".
    void this.health.syncPhoneTrackFilter();

    await this.loadData();
    this.loading.set(false);
  }

  async loadData(): Promise<void> {
    const date = this.selectedDate();
    try {
      const [activity, sleep, stages, hrIntraday, velocity] = await Promise.all([
        this.health.getActivity(30),
        this.health.getSleep(30),
        this.health.getSleepStages(date),
        this.health.getHeartRateIntraday(date),
        this.health.getVelocity(date).catch(() => null),
      ]);

      this.activity.set(activity);
      this.sleep.set(sleep);
      this.sleepStages.set(stages);
      this.intradayHr.set(hrIntraday);
      this.velocity.set(velocity);

      // Show only data that actually belongs to the selected date — no
      // silent fallback to "the latest". An empty card is correct when
      // today's data hasn't synced yet (e.g. sleep before the next sync).
      const dayActivity = activity.find((a) => a.date.startsWith(date));
      this.latestActivity.set(dayActivity ?? null);

      const dayMainSleep = sleep.find((s) => s.is_main_sleep && s.date.startsWith(date));
      this.latestSleep.set(dayMainSleep ?? null);
    } catch (e) {
      console.error("Failed to load data:", e);
    }
  }

  async changeDay(delta: number): Promise<void> {
    const d = new Date(this.selectedDate() + "T12:00:00"); // noon to avoid DST edge
    d.setDate(d.getDate() + delta);
    const newDate = formatDateInTz(d, browserTimezone());
    // Don't go into the future
    if (newDate > todayLocal()) return;
    // Push to URL — the queryParamMap subscription in ngOnInit drives
    // the rest (sets the signal, triggers loadData). Single source of
    // truth so back/forward navigation and in-app left/right behave
    // identically.
    this.writeDateToUrl(newDate, /* push */ true);
  }

  isToday(): boolean {
    return this.selectedDate() === todayLocal();
  }

  formatDisplayDate(): string {
    const date = this.selectedDate();
    if (date === todayLocal()) return "Today";
    const d = new Date(date + "T12:00:00");
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (date === formatDateInTz(yesterday, browserTimezone())) return "Yesterday";
    return d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
  }
}
