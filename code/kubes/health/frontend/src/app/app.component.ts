import { Component, signal, OnInit } from "@angular/core";
import { CommonModule } from "@angular/common";
import { HealthService, type ActivityDay, type SleepLog } from "./services/health.service";
import { SummaryCardsComponent } from "./components/summary-cards/summary-cards.component";
import { StepsChartComponent } from "./components/steps-chart/steps-chart.component";
import { HeartrateChartComponent } from "./components/heartrate-chart/heartrate-chart.component";
import { SleepChartComponent } from "./components/sleep-chart/sleep-chart.component";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [CommonModule, SummaryCardsComponent, StepsChartComponent, HeartrateChartComponent, SleepChartComponent],
  template: `
    <div class="app">
      <header>
        <h1>Health Dashboard</h1>
        @if (health.user(); as user) {
          <div class="user-info">
            <span>{{ user.displayName }}</span>
            <a href="/logout">Logout</a>
          </div>
        }
      </header>

      @if (!authenticated()) {
        <div class="login-prompt">
          <p>Sign in to view your health data.</p>
          <a href="/login" class="login-btn">Sign in with Nextcloud</a>
        </div>
      } @else if (loading()) {
        <div class="loading">Loading...</div>
      } @else {
        <app-summary-cards
          [latestActivity]="latestActivity()"
          [latestSleep]="latestSleep()"
        />

        <div class="charts-grid">
          <app-steps-chart [activity]="activity()" />
          <app-heartrate-chart [activity]="activity()" />
        </div>

        <app-sleep-chart [sleep]="sleep()" />
      }
    </div>
  `,
  styles: [`
    .app {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e0e0f0;
      min-height: 100vh;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin: 0;
    }
    .user-info {
      display: flex;
      align-items: center;
      gap: 16px;
      color: #a0a0b0;
      font-size: 14px;
    }
    .user-info a {
      color: #6366f1;
      text-decoration: none;
    }
    .charts-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 768px) {
      .charts-grid {
        grid-template-columns: 1fr;
      }
    }
    .login-prompt {
      text-align: center;
      padding: 80px 20px;
    }
    .login-btn {
      display: inline-block;
      background: #6366f1;
      color: white;
      padding: 12px 32px;
      border-radius: 8px;
      text-decoration: none;
      font-size: 16px;
    }
    .loading {
      text-align: center;
      padding: 80px;
      color: #a0a0b0;
    }
  `],
})
export class AppComponent implements OnInit {
  readonly activity = signal<ActivityDay[]>([]);
  readonly sleep = signal<SleepLog[]>([]);
  readonly latestActivity = signal<ActivityDay | null>(null);
  readonly latestSleep = signal<SleepLog | null>(null);
  readonly authenticated = signal(false);
  readonly loading = signal(true);

  constructor(readonly health: HealthService) {}

  async ngOnInit(): Promise<void> {
    const ok = await this.health.checkAuth();
    this.authenticated.set(ok);
    if (!ok) {
      this.loading.set(false);
      return;
    }

    try {
      const [activity, sleep] = await Promise.all([
        this.health.getActivity(30),
        this.health.getSleep(30),
      ]);

      this.activity.set(activity);
      this.sleep.set(sleep);

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
