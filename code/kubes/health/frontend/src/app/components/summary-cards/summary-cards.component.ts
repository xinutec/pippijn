import { Component, input } from "@angular/core";
import type { ActivityDay, SleepLog } from "../../services/health.service";

@Component({
  selector: "app-summary-cards",
  standalone: true,
  template: `
    <div class="cards">
      @if (latestActivity(); as a) {
        <div class="card">
          <div class="card-label">Steps Today</div>
          <div class="card-value">{{ a.steps | number }}</div>
        </div>
        <div class="card">
          <div class="card-label">Resting HR</div>
          <div class="card-value">{{ a.resting_heart_rate ?? '—' }} <span class="unit">bpm</span></div>
        </div>
        <div class="card">
          <div class="card-label">Active Minutes</div>
          <div class="card-value">{{ a.minutes_fairly_active + a.minutes_very_active }}</div>
        </div>
        <div class="card">
          <div class="card-label">Calories</div>
          <div class="card-value">{{ a.calories_total | number }}</div>
        </div>
      }
      @if (latestSleep(); as s) {
        <div class="card">
          <div class="card-label">Last Sleep</div>
          <div class="card-value">{{ formatDuration(s.duration_ms) }}</div>
        </div>
        <div class="card">
          <div class="card-label">Sleep Efficiency</div>
          <div class="card-value">{{ s.efficiency }}<span class="unit">%</span></div>
        </div>
      }
    </div>
  `,
  styles: [`
    .cards {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }
    .card {
      background: #1e1e2e;
      border-radius: 12px;
      padding: 20px 24px;
      min-width: 150px;
      flex: 1;
    }
    .card-label {
      color: #a0a0b0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .card-value {
      color: #e0e0f0;
      font-size: 28px;
      font-weight: 600;
    }
    .unit {
      font-size: 14px;
      color: #a0a0b0;
      font-weight: 400;
    }
  `],
})
export class SummaryCardsComponent {
  readonly latestActivity = input<ActivityDay | null>(null);
  readonly latestSleep = input<SleepLog | null>(null);

  formatDuration(ms: number): string {
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${mins}m`;
  }
}
