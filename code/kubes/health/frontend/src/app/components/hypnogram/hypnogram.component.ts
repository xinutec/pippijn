import { Component, input, effect } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { SleepStage } from "../../services/health.service";
import { tickColor, gridColor } from "../../chart-theme";

// Y-axis: Awake at top (3), Deep at bottom (0) — matches Fitbit
const STAGE_LEVELS: Record<string, number> = {
  wake: 3, awake: 3,
  rem: 2, restless: 2,
  light: 1, asleep: 1,
  deep: 0,
};

const STAGE_COLORS: Record<string, string> = {
  wake: "#f472b6",   // pink (Fitbit awake)
  awake: "#f472b6",
  rem: "#67e8f9",    // cyan (Fitbit REM)
  restless: "#f472b6",
  light: "#60a5fa",  // blue (Fitbit light)
  asleep: "#60a5fa",
  deep: "#a78bfa",   // purple (Fitbit deep)
};

@Component({
  selector: "app-hypnogram",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  template: `
    <mat-card>
      <mat-card-header><mat-card-title>Sleep Stages</mat-card-title></mat-card-header>
      <mat-card-content>
        @if (stages().length === 0) {
          <p class="no-data">No sleep stage data available</p>
        } @else {
          <canvas baseChart [data]="chartData" [options]="chartOptions" type="bar"
                  style="min-height: 220px;"></canvas>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: [`
    .no-data { opacity: 0.5; padding: 24px 0; text-align: center; }
  `],
})
export class HypnogramComponent {
  readonly stages = input<SleepStage[]>([]);

  chartData: ChartConfiguration<"bar">["data"] = { labels: [], datasets: [] };
  chartOptions: ChartConfiguration<"bar">["options"] = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: "x",
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const stageNames: Record<number, string> = { 0: "Deep", 1: "Light", 2: "REM", 3: "Awake" };
            return stageNames[ctx.raw as number] ?? "";
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 11 } },
        grid: { display: false },
      },
      y: {
        min: -0.3,
        max: 3.5,
        ticks: {
          color: tickColor,
          stepSize: 1,
          font: { size: 12 },
          callback: (v) => {
            const labels: Record<number, string> = { 0: "Deep", 1: "Light", 2: "REM", 3: "Awake" };
            return labels[v as number] ?? "";
          },
        },
        grid: { color: gridColor },
      },
    },
  };

  constructor() {
    effect(() => {
      const data = this.stages();
      if (data.length === 0) return;

      // Build one bar per stage transition, colored by stage
      const labels: string[] = [];
      const values: number[] = [];
      const colors: string[] = [];

      for (const stage of data) {
        const time = new Date(stage.ts);
        const fmt = time.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
        const level = STAGE_LEVELS[stage.stage] ?? 1;
        const color = STAGE_COLORS[stage.stage] ?? "#60a5fa";

        // Add a bar for each stage segment
        const segments = Math.max(1, Math.round(stage.duration_seconds / 120)); // one bar per ~2 min
        for (let i = 0; i < segments; i++) {
          const t = new Date(time.getTime() + i * 120 * 1000);
          labels.push(t.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false }));
          values.push(level);
          colors.push(color);
        }
      }

      this.chartData = {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderWidth: 0,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        }],
      };
    });
  }
}
