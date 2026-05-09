import { Component, input, effect } from "@angular/core";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { ActivityDay } from "../../services/health.service";

@Component({
  selector: "app-heartrate-chart",
  standalone: true,
  imports: [BaseChartDirective],
  template: `
    <div class="chart-container">
      <h3>Resting Heart Rate</h3>
      <canvas baseChart [data]="chartData" [options]="chartOptions" type="line"></canvas>
    </div>
  `,
  styles: [`
    .chart-container {
      background: #1e1e2e;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    h3 {
      color: #e0e0f0;
      margin: 0 0 16px 0;
      font-weight: 500;
    }
  `],
})
export class HeartrateChartComponent {
  readonly activity = input<ActivityDay[]>([]);

  chartData: ChartConfiguration<"line">["data"] = { labels: [], datasets: [] };
  chartOptions: ChartConfiguration<"line">["options"] = {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: "#a0a0b0" }, grid: { display: false } },
      y: {
        ticks: { color: "#a0a0b0" },
        grid: { color: "#2a2a3e" },
        suggestedMin: 50,
        suggestedMax: 90,
      },
    },
  };

  constructor() {
    effect(() => {
      const data = this.activity().filter((d) => d.resting_heart_rate != null);
      this.chartData = {
        labels: data.map((d) => new Date(d.date).toLocaleDateString("en", { month: "short", day: "numeric" })),
        datasets: [
          {
            data: data.map((d) => d.resting_heart_rate!),
            borderColor: "#ef4444",
            backgroundColor: "rgba(239, 68, 68, 0.1)",
            fill: true,
            tension: 0.3,
            pointRadius: 3,
          },
        ],
      };
    });
  }
}
