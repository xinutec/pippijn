import { Component, effect, input } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { ChartConfiguration } from "chart.js";
import { BaseChartDirective } from "ng2-charts";
import { chartColors, formatDay, gridColor, tickColor } from "../../chart-theme";
import type { BodyDay } from "../../services/health.service";

@Component({
  selector: "app-weight-chart",
  standalone: true,
  imports: [MatCardModule, BaseChartDirective],
  templateUrl: "./weight-chart.component.html",
  styleUrl: "./weight-chart.component.scss",
})
export class WeightChartComponent {
  readonly body = input<BodyDay[]>([]);

  private static readonly PAD_KG = 1;
  private static readonly MIN_SPAN_KG = 4;

  chartData: ChartConfiguration<"line">["data"] = { labels: [], datasets: [] };
  chartOptions: ChartConfiguration<"line">["options"] = this.buildOptions(60, 80);

  private buildOptions(min: number, max: number): ChartConfiguration<"line">["options"] {
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: true, labels: { color: tickColor } },
        tooltip: { callbacks: { label: (ctx) => `${(ctx.raw as number).toFixed(1)} kg` } },
      },
      scales: {
        x: { ticks: { color: tickColor }, grid: { display: false } },
        y: {
          ticks: { color: tickColor, callback: (v) => `${v} kg` },
          grid: { color: gridColor },
          min,
          max,
        },
      },
    };
  }

  constructor() {
    effect(() => {
      // Weight is a DECIMAL (string off the wire); coerce and drop blank days.
      const pts = this.body()
        .map((d) => ({ date: d.date, kg: d.weight_kg == null ? Number.NaN : Number(d.weight_kg) }))
        .filter((d) => Number.isFinite(d.kg) && d.kg > 0);

      if (pts.length === 0) {
        this.chartData = { labels: [], datasets: [] };
        return;
      }

      const vals = pts.map((d) => d.kg);
      let lo = Math.floor(Math.min(...vals) - WeightChartComponent.PAD_KG);
      let hi = Math.ceil(Math.max(...vals) + WeightChartComponent.PAD_KG);
      const span = hi - lo;
      if (span < WeightChartComponent.MIN_SPAN_KG) {
        const grow = (WeightChartComponent.MIN_SPAN_KG - span) / 2;
        lo = Math.floor(lo - grow);
        hi = Math.ceil(hi + grow);
      }
      this.chartOptions = this.buildOptions(Math.max(0, lo), hi);

      this.chartData = {
        labels: pts.map((d) => formatDay(d.date)),
        datasets: [
          {
            label: "Weight",
            data: vals,
            borderColor: chartColors.green,
            backgroundColor: "rgba(34, 197, 94, 0.1)",
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
        ],
      };
    });
  }
}
