import { Component, input } from "@angular/core";
import { DecimalPipe } from "@angular/common";
import { MatCardModule } from "@angular/material/card";
import type { ActivityDay, SleepLog } from "../../services/health.service";

@Component({
  selector: "app-summary-cards",
  standalone: true,
  imports: [DecimalPipe, MatCardModule],
  template: `
    <div class="cards">
      @if (latestActivity(); as a) {
        <mat-card class="stat-card">
          <mat-card-content>
            <div class="label">Steps</div>
            <div class="value">{{ a.steps | number }}</div>
          </mat-card-content>
        </mat-card>
        <mat-card class="stat-card">
          <mat-card-content>
            <div class="label">Resting HR</div>
            <div class="value">{{ a.resting_heart_rate ?? '—' }} <span class="unit">bpm</span></div>
          </mat-card-content>
        </mat-card>
        <mat-card class="stat-card">
          <mat-card-content>
            <div class="label">Active Minutes</div>
            <div class="value">{{ a.minutes_fairly_active + a.minutes_very_active }}</div>
          </mat-card-content>
        </mat-card>
        <mat-card class="stat-card">
          <mat-card-content>
            <div class="label">Calories</div>
            <div class="value">{{ a.calories_total | number }}</div>
          </mat-card-content>
        </mat-card>
      }
      @if (latestSleep(); as s) {
        <mat-card class="stat-card">
          <mat-card-content>
            <div class="label">Sleep</div>
            <div class="value">{{ formatMinutes(s.minutes_asleep) }}</div>
          </mat-card-content>
        </mat-card>
        <mat-card class="stat-card">
          <mat-card-content>
            <div class="label">Sleep Efficiency</div>
            <div class="value">{{ s.efficiency }}<span class="unit">%</span></div>
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .cards {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .stat-card {
      flex: 1;
      min-width: 140px;
    }
    .label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.6;
      margin-bottom: 4px;
    }
    .value {
      font-size: 28px;
      font-weight: 500;
    }
    .unit {
      font-size: 14px;
      opacity: 0.5;
      font-weight: 400;
    }
  `],
})
export class SummaryCardsComponent {
  readonly latestActivity = input<ActivityDay | null>(null);
  readonly latestSleep = input<SleepLog | null>(null);

  formatMinutes(mins: number): string {
    const hours = Math.floor(mins / 60);
    const m = mins % 60;
    return `${hours}h ${m}m`;
  }
}
