import { Component, input, effect } from "@angular/core";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { ActivityDay } from "../../services/health.service";

@Component({
  selector: "app-steps-chart",
  standalone: true,
  imports: [BaseChartDirective],
  template: `
    <div class="chart-container">
      <h3>Steps</h3>
      <canvas baseChart [data]="chartData" [options]="chartOptions" type="bar"></canvas>
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
export class StepsChartComponent {
  readonly activity = input<ActivityDay[]>([]);

  chartData: ChartConfiguration<"bar">["data"] = { labels: [], datasets: [] };
  chartOptions: ChartConfiguration<"bar">["options"] = {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: "#a0a0b0" }, grid: { display: false } },
      y: { ticks: { color: "#a0a0b0" }, grid: { color: "#2a2a3e" } },
    },
  };

  constructor() {
    effect(() => {
      const data = this.activity();
      this.chartData = {
        labels: data.map((d) => new Date(d.date).toLocaleDateString("en", { month: "short", day: "numeric" })),
        datasets: [
          {
            data: data.map((d) => d.steps),
            backgroundColor: "#6366f1",
            borderRadius: 4,
          },
        ],
      };
    });
  }
}
