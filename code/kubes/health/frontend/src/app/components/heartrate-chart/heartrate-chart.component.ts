import { Component, input, effect } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { ActivityDay } from "../../services/health.service";
import { chartColors, gridColor, tickColor, formatDay } from "../../chart-theme";

@Component({
  selector: "app-heartrate-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: './heartrate-chart.component.html',
  styleUrl: './heartrate-chart.component.scss',
})
export class HeartrateChartComponent {
  readonly activity = input<ActivityDay[]>([]);

  chartData: ChartConfiguration<"line">["data"] = { labels: [], datasets: [] };
  chartOptions: ChartConfiguration<"line">["options"] = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: tickColor }, grid: { display: false } },
      y: {
        ticks: { color: tickColor },
        grid: { color: gridColor },
        suggestedMin: 50,
        suggestedMax: 90,
      },
    },
  };

  constructor() {
    effect(() => {
      const data = this.activity().filter((d) => d.resting_heart_rate != null);
      this.chartData = {
        labels: data.map((d) => formatDay(d.date)),
        datasets: [{
          data: data.map((d) => d.resting_heart_rate!),
          borderColor: chartColors.red,
          backgroundColor: "rgba(239, 68, 68, 0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }],
      };
    });
  }
}
