import { Component, input, effect } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { SleepStage } from "../../services/health.service";
import { chartColors, tickColor, gridColor } from "../../chart-theme";

// Y-axis: Awake at top (3), Deep at bottom (0) — matches Fitbit layout
const STAGE_LEVELS: Record<string, number> = {
  wake: 3, awake: 3,
  rem: 2, restless: 2,
  light: 1, asleep: 1,
  deep: 0,
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
          <canvas baseChart [data]="chartData" [options]="chartOptions" type="line"
                  style="min-height: 200px;"></canvas>
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

  chartData: ChartConfiguration<"line">["data"] = { labels: [], datasets: [] };
  chartOptions: ChartConfiguration<"line">["options"] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: {
        ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 11 } },
        grid: { display: false },
      },
      y: {
        reverse: true,
        min: -0.3,
        max: 3.3,
        ticks: {
          color: tickColor,
          stepSize: 1,
          font: { size: 12 },
          callback: (v) => {
            const labels: Record<number, string> = { 3: "Awake", 2: "REM", 1: "Light", 0: "Deep" };
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

      const points: Array<{ x: string; y: number }> = [];

      for (const stage of data) {
        const time = new Date(stage.ts);
        const level = STAGE_LEVELS[stage.stage] ?? 1;
        const fmt = (d: Date) => d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });

        points.push({ x: fmt(time), y: level });
        const end = new Date(time.getTime() + stage.duration_seconds * 1000);
        points.push({ x: fmt(end), y: level });
      }

      this.chartData = {
        labels: points.map((p) => p.x),
        datasets: [{
          data: points.map((p) => p.y),
          borderColor: chartColors.purple,
          backgroundColor: "rgba(139, 92, 246, 0.15)",
          fill: true,
          stepped: "before",
          pointRadius: 0,
          borderWidth: 1.5,
        }],
      };
    });
  }
}
