import { Component, signal, OnInit } from "@angular/core";
import { MatToolbarModule } from "@angular/material/toolbar";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatTabsModule } from "@angular/material/tabs";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import {
  HealthService,
  type ActivityDay, type SleepLog, type SleepStage, type HeartRatePoint, type VelocityData,
} from "./services/health.service";
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
    SummaryCardsComponent, HypnogramComponent, IntradayHrComponent, SpeedChartComponent, TimelineComponent,
    StepsChartComponent, HeartrateChartComponent, SleepChartComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
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

  constructor(readonly health: HealthService) {}

  async ngOnInit(): Promise<void> {
    const ok = await this.health.checkAuth();
    this.authenticated.set(ok);
    if (!ok) { this.loading.set(false); return; }

    this.fitbitLinked.set(this.health.user()?.fitbitLinked ?? false);
    if (!this.fitbitLinked()) { this.loading.set(false); return; }

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

      if (activity.length > 0) {
        // Find the activity for the selected date, or fall back to latest
        const dayActivity = activity.find(a => a.date.startsWith(date));
        this.latestActivity.set(dayActivity ?? activity[activity.length - 1]);
      }
      const mainSleeps = sleep.filter((s) => s.is_main_sleep);
      const daySleep = mainSleeps.find(s => s.date.startsWith(date));
      this.latestSleep.set(daySleep ?? mainSleeps[mainSleeps.length - 1] ?? null);
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
    this.selectedDate.set(newDate);
    this.dayLoading.set(true);
    await this.loadData();
    this.dayLoading.set(false);
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
