import { Component, input, effect } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { BaseChartDirective } from "ng2-charts";
import type { ChartConfiguration } from "chart.js";
import type { SleepStage } from "../../services/health.service";
import { chartColors, tickColor, gridColor } from "../../chart-theme";

const STAGE_LEVELS: Record<string, number> = {
  wake: 3,
  rem: 2,
  light: 1,
  deep: 0,
  restless: 2.5,
  asleep: 0.5,
  awake: 3,
};

const STAGE_COLORS: Record<string, string> = {
  wake: chartColors.amber,
  rem: chartColors.purple,
  light: chartColors.blue,
  deep: chartColors.deepBlue,
  restless: chartColors.amber,
  asleep: chartColors.blue,
  awake: chartColors.amber,
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
          <canvas baseChart [data]="chartData" [options]="chartOptions" type="line"></canvas>
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
    maintainAspectRatio: true,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: tickColor, maxTicksLimit: 8 },
        grid: { display: false },
      },
      y: {
        reverse: true,
        ticks: {
          color: tickColor,
          callback: (v) => {
            const labels: Record<number, string> = { 0: "Deep", 1: "Light", 2: "REM", 3: "Awake" };
            return labels[v as number] ?? "";
          },
          stepSize: 1,
        },
        grid: { color: gridColor },
        min: -0.5,
        max: 3.5,
      },
    },
  };

  constructor() {
    effect(() => {
      const data = this.stages();
      if (data.length === 0) return;

      // Build points: each stage becomes a horizontal segment
      const points: Array<{ x: string; y: number }> = [];
      const colors: string[] = [];

      for (const stage of data) {
        const time = new Date(stage.ts);
        const timeStr = time.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
        const level = STAGE_LEVELS[stage.stage] ?? 1;

        points.push({ x: timeStr, y: level });

        // Add end of this stage
        const endTime = new Date(time.getTime() + stage.duration_seconds * 1000);
        const endStr = endTime.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
        points.push({ x: endStr, y: level });

        colors.push(STAGE_COLORS[stage.stage] ?? chartColors.blue);
      }

      this.chartData = {
        labels: points.map((p) => p.x),
        datasets: [{
          data: points.map((p) => p.y),
          borderColor: chartColors.purple,
          backgroundColor: "rgba(139, 92, 246, 0.1)",
          fill: true,
          stepped: "before",
          pointRadius: 0,
          borderWidth: 2,
        }],
      };
    });
  }
}
