import { Component, signal, OnInit } from "@angular/core";
import { MatToolbarModule } from "@angular/material/toolbar";
import { MatButtonModule } from "@angular/material/button";
import { MatButtonToggleModule } from "@angular/material/button-toggle";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import {
  HealthService,
  type ActivityDay, type SleepLog, type SleepStage, type HeartRatePoint,
} from "./services/health.service";
import { SummaryCardsComponent } from "./components/summary-cards/summary-cards.component";
import { HypnogramComponent } from "./components/hypnogram/hypnogram.component";
import { IntradayHrComponent } from "./components/intraday-hr/intraday-hr.component";
import { StepsChartComponent } from "./components/steps-chart/steps-chart.component";
import { HeartrateChartComponent } from "./components/heartrate-chart/heartrate-chart.component";
import { SleepChartComponent } from "./components/sleep-chart/sleep-chart.component";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    MatToolbarModule, MatButtonModule, MatButtonToggleModule, MatProgressSpinnerModule,
    SummaryCardsComponent, HypnogramComponent, IntradayHrComponent,
    StepsChartComponent, HeartrateChartComponent, SleepChartComponent,
  ],
  template: `
    <mat-toolbar color="primary" class="toolbar">
      <span class="title">Health</span>
      @if (authenticated() && fitbitLinked()) {
        <mat-button-toggle-group [value]="view()" (change)="view.set($event.value)" class="view-toggle">
          <mat-button-toggle value="today">Today</mat-button-toggle>
          <mat-button-toggle value="trends">Trends</mat-button-toggle>
        </mat-button-toggle-group>
      }
      <span class="spacer"></span>
      @if (health.user(); as user) {
        <span class="user-name">{{ user.displayName }}</span>
        <form method="POST" action="/logout" class="logout-form">
          <button mat-button type="submit">Logout</button>
        </form>
      }
    </mat-toolbar>

    <main class="content">
      @if (!authenticated()) {
        <div class="prompt">
          <h2>Sign in to view your health data</h2>
          <a mat-raised-button color="primary" href="/login">Sign in with Nextcloud</a>
        </div>
      } @else if (loading()) {
        <div class="loading">
          <mat-spinner diameter="48"></mat-spinner>
          <p>Loading your health data...</p>
        </div>
      } @else if (!fitbitLinked()) {
        <div class="prompt">
          <h2>Link your Fitbit account</h2>
          <p>Connect your Fitbit to start tracking your health data.</p>
          <a mat-raised-button color="primary" href="/fitbit/auth">Link Fitbit</a>
        </div>
      } @else if (view() === 'today') {
        <app-summary-cards
          [latestActivity]="latestActivity()"
          [latestSleep]="latestSleep()"
        />
        <app-hypnogram [stages]="sleepStages()" />
        <app-intraday-hr [points]="intradayHr()" />
      } @else {
        <app-summary-cards
          [latestActivity]="latestActivity()"
          [latestSleep]="latestSleep()"
        />
        <div class="charts-row">
          <app-steps-chart [activity]="activity()" />
          <app-heartrate-chart [activity]="activity()" />
        </div>
        <app-sleep-chart [sleep]="sleep()" />
      }
    </main>
  `,
  styles: [`
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .title { font-size: 18px; font-weight: 600; margin-right: 16px; }
    .view-toggle { margin-left: 8px; }
    .spacer { flex: 1; }
    .user-name { font-size: 14px; opacity: 0.8; margin-right: 8px; }
    .logout-form { display: inline; }
    .content {
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px;
    }
    .prompt {
      text-align: center;
      padding: 80px 20px;
      h2 { margin-bottom: 16px; font-weight: 500; }
      p { margin-bottom: 24px; opacity: 0.7; }
    }
    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 80px;
      p { opacity: 0.7; }
    }
    .charts-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    @media (max-width: 900px) {
      .charts-row { grid-template-columns: 1fr; }
      .content { padding: 16px; }
    }
  `],
})
export class AppComponent implements OnInit {
  readonly view = signal<"today" | "trends">("today");
  readonly activity = signal<ActivityDay[]>([]);
  readonly sleep = signal<SleepLog[]>([]);
  readonly sleepStages = signal<SleepStage[]>([]);
  readonly intradayHr = signal<HeartRatePoint[]>([]);
  readonly latestActivity = signal<ActivityDay | null>(null);
  readonly latestSleep = signal<SleepLog | null>(null);
  readonly authenticated = signal(false);
  readonly fitbitLinked = signal(false);
  readonly loading = signal(true);

  constructor(readonly health: HealthService) {}

  async ngOnInit(): Promise<void> {
    const ok = await this.health.checkAuth();
    this.authenticated.set(ok);
    if (!ok) { this.loading.set(false); return; }

    this.fitbitLinked.set(this.health.user()?.fitbitLinked ?? false);
    if (!this.fitbitLinked()) { this.loading.set(false); return; }

    try {
      // Fetch all data in parallel
      const [activity, sleep, stages, hrIntraday] = await Promise.all([
        this.health.getActivity(30),
        this.health.getSleep(30),
        this.health.getSleepStages(),
        this.health.getHeartRateIntraday(),
      ]);

      this.activity.set(activity);
      this.sleep.set(sleep);
      this.sleepStages.set(stages);
      this.intradayHr.set(hrIntraday);

      if (activity.length > 0) {
        this.latestActivity.set(activity[activity.length - 1]);
      }
      const mainSleeps = sleep.filter((s) => s.is_main_sleep);
      if (mainSleeps.length > 0) {
        this.latestSleep.set(mainSleeps[mainSleeps.length - 1]);
      }
    } catch (e) {
      console.error("Failed to load data:", e);
    } finally {
      this.loading.set(false);
    }
  }
}
