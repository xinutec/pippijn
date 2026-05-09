import { Component, input } from "@angular/core";
import { DecimalPipe } from "@angular/common";
import { MatCardModule } from "@angular/material/card";
import type { ActivityDay, SleepLog } from "../../services/health.service";

@Component({
  selector: "app-summary-cards",
  standalone: true,
  imports: [DecimalPipe, MatCardModule],
  templateUrl: './summary-cards.component.html',
  styleUrl: './summary-cards.component.scss',
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
