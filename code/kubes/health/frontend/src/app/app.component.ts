import { Component, OnInit, inject, signal } from "@angular/core";
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
import { SettingsComponent } from "./components/settings/settings.component";
import { SummaryCardsComponent } from "./components/summary-cards/summary-cards.component";
import { HypnogramComponent } from "./components/hypnogram/hypnogram.component";
import { IntradayHrComponent } from "./components/intraday-hr/intraday-hr.component";
import { SpeedChartComponent } from "./components/speed-chart/speed-chart.component";
import { TimelineComponent } from "./components/timeline/timeline.component";
import { StepsChartComponent } from "./components/steps-chart/steps-chart.component";
import { HeartrateChartComponent } from "./components/heartrate-chart/heartrate-chart.component";
import { SleepChartComponent } from "./components/sleep-chart/sleep-chart.component";
import { formatDateInTz, browserTimezone, todayLocal } from "./time-utils";
import { installErrorReporting, logBootContext } from "./client-diagnostics";

/** What the app is showing right now. Driven by URL path at boot;
 *  doesn't change without a navigation. */
type AppMode = "dashboard" | "settings" | "share";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    MatToolbarModule, MatButtonModule, MatIconModule, MatTabsModule, MatProgressSpinnerModule,
    ReauthBannerComponent, SettingsComponent,
    SummaryCardsComponent, HypnogramComponent, IntradayHrComponent, SpeedChartComponent, TimelineComponent,
    StepsChartComponent, HeartrateChartComponent, SleepChartComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  readonly mode = signal<AppMode>(detectMode());
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

  constructor(readonly health: HealthService) {}

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
    // Install browser error/unhandledrejection listeners up-front so
    // any failure during auth or initial render still gets reported.
    // Best-effort — the install itself never throws.
    installErrorReporting(this.health);

    // Share mode: the URL was /share/:token. Stash the token in the
    // service so every API call attaches it as a header. The rest of
    // the dashboard then renders normally — the server-side gates
    // enforce read-only + date-window.
    if (this.mode() === "share") {
      const token = extractShareTokenFromPath();
      if (token) this.health.shareToken.set(token);
    }

    // Settings mode short-circuits the dashboard data load — the
    // SettingsComponent fetches what it needs.
    if (this.mode() === "settings") {
      const okSettings = await this.health.checkAuth();
      this.authenticated.set(okSettings);
      this.loading.set(false);
      return;
    }

    const ok = await this.health.checkAuth();
    this.authenticated.set(ok);
    if (!ok) { this.loading.set(false); return; }

    // One-shot boot context (UA, viewport, tz, locale) for future
    // bug-correlation. Posted after auth succeeds so it carries the
    // authenticated user_id in the log prefix.
    logBootContext(this.health);

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
    // Skip in share-viewer mode — the backend would 403 (read-only),
    // and the recipient has no business touching the owner's PhoneTrack
    // prefs anyway.
    if (this.mode() !== "share") {
      void this.health.syncPhoneTrackFilter();
    }

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

/** Inspect window.location.pathname once at boot and pick the mode.
 *  No reactive re-detection — navigating between modes is a full
 *  page load (plain anchor href), so a single static read is fine. */
function detectMode(): AppMode {
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  if (path.startsWith("/share/")) return "share";
  if (path === "/settings" || path.startsWith("/settings/")) return "settings";
  return "dashboard";
}

/** Pull the token out of /share/:token. Returns null if the path
 *  shape doesn't match — caller should fall back to owner mode. */
function extractShareTokenFromPath(): string | null {
  const path = window.location.pathname;
  const match = path.match(/^\/share\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
