import { Component, input, effect } from "@angular/core";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { SleepLog } from "../../services/health.service";

@Component({
  selector: "app-sleep-chart",
  standalone: true,
  imports: [BaseChartDirective],
  template: `
    <div class="chart-container">
      <h3>Sleep</h3>
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
export class SleepChartComponent {
  readonly sleep = input<SleepLog[]>([]);

  chartData: ChartConfiguration<"bar">["data"] = { labels: [], datasets: [] };
  chartOptions: ChartConfiguration<"bar">["options"] = {
    responsive: true,
    plugins: {
      legend: {
        labels: { color: "#a0a0b0" },
      },
    },
    scales: {
      x: {
        stacked: true,
        ticks: { color: "#a0a0b0" },
        grid: { display: false },
      },
      y: {
        stacked: true,
        ticks: {
          color: "#a0a0b0",
          callback: (v) => `${v}h`,
        },
        grid: { color: "#2a2a3e" },
      },
    },
  };

  constructor() {
    effect(() => {
      const mainSleeps = this.sleep().filter((s) => s.is_main_sleep);
      const labels = mainSleeps.map((s) =>
        new Date(s.date).toLocaleDateString("en", { month: "short", day: "numeric" })
      );

      const toHours = (mins: number | null) => (mins ?? 0) / 60;

      this.chartData = {
        labels,
        datasets: [
          {
            label: "Deep",
            data: mainSleeps.map((s) => toHours(s.minutes_deep)),
            backgroundColor: "#1e3a5f",
            borderRadius: 2,
          },
          {
            label: "Light",
            data: mainSleeps.map((s) => toHours(s.minutes_light)),
            backgroundColor: "#3b82f6",
            borderRadius: 2,
          },
          {
            label: "REM",
            data: mainSleeps.map((s) => toHours(s.minutes_rem)),
            backgroundColor: "#8b5cf6",
            borderRadius: 2,
          },
          {
            label: "Awake",
            data: mainSleeps.map((s) => toHours(s.minutes_wake)),
            backgroundColor: "#f59e0b",
            borderRadius: 2,
          },
        ],
      };
    });
  }
}
