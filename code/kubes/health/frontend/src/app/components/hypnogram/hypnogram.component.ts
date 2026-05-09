import { Component, input, effect, ElementRef, viewChild } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { SleepStage } from "../../services/health.service";

// Y positions: Awake at top, Deep at bottom
const STAGE_Y: Record<string, number> = {
  wake: 0, awake: 0,
  rem: 1, restless: 1,
  light: 2, asleep: 2,
  deep: 3,
};

const STAGE_COLORS: Record<string, string> = {
  wake: "#f472b6",   // pink
  awake: "#f472b6",
  rem: "#67e8f9",    // cyan
  restless: "#f472b6",
  light: "#60a5fa",  // blue
  asleep: "#60a5fa",
  deep: "#a78bfa",   // purple
};

const STAGE_LABELS = ["Awake", "REM", "Light", "Deep"];

@Component({
  selector: "app-hypnogram",
  standalone: true,
  imports: [MatCardModule],
  template: `
    <mat-card>
      <mat-card-header><mat-card-title>Sleep Stages</mat-card-title></mat-card-header>
      <mat-card-content>
        @if (stages().length === 0) {
          <p class="no-data">No sleep stage data available</p>
        } @else {
          <div class="hypnogram-container">
            <div class="y-labels">
              @for (label of stageLabels; track label) {
                <span>{{ label }}</span>
              }
            </div>
            <div class="canvas-wrap">
              <canvas #canvas></canvas>
              <div class="x-labels">
                @for (label of timeLabels; track label) {
                  <span>{{ label }}</span>
                }
              </div>
            </div>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: [`
    .no-data { opacity: 0.5; padding: 24px 0; text-align: center; }
    .hypnogram-container {
      display: flex;
      gap: 8px;
      padding: 8px 0;
    }
    .y-labels {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 4px 0 24px 0;
      font-size: 12px;
      color: rgba(255,255,255,0.5);
      min-width: 48px;
      text-align: right;
    }
    .canvas-wrap {
      flex: 1;
      min-height: 180px;
    }
    canvas {
      width: 100% !important;
      height: 160px !important;
    }
    .x-labels {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: rgba(255,255,255,0.5);
      padding-top: 4px;
    }
  `],
})
export class HypnogramComponent {
  readonly stages = input<SleepStage[]>([]);
  readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>("canvas");
  readonly stageLabels = STAGE_LABELS;
  timeLabels: string[] = [];

  constructor() {
    effect(() => {
      const data = this.stages();
      const canvasEl = this.canvasRef();
      if (data.length === 0 || !canvasEl) return;

      const canvas = canvasEl.nativeElement;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Compute time range
      const firstTime = new Date(data[0].ts).getTime();
      const lastStage = data[data.length - 1];
      const lastTime = new Date(lastStage.ts).getTime() + lastStage.duration_seconds * 1000;
      const totalMs = lastTime - firstTime;

      // Set canvas size
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const w = rect.width;
      const h = rect.height;

      // Drawing area
      const padTop = 8;
      const padBottom = 8;
      const drawH = h - padTop - padBottom;
      const laneH = drawH / 4; // 4 stages

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Draw grid lines
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const y = padTop + i * laneH + laneH / 2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Draw each stage as a filled rectangle in its lane
      for (const stage of data) {
        const stageStart = new Date(stage.ts).getTime();
        const stageEnd = stageStart + stage.duration_seconds * 1000;

        const x1 = ((stageStart - firstTime) / totalMs) * w;
        const x2 = ((stageEnd - firstTime) / totalMs) * w;
        const level = STAGE_Y[stage.stage] ?? 2;
        const color = STAGE_COLORS[stage.stage] ?? "#60a5fa";

        const y = padTop + level * laneH + 2;
        const barH = laneH - 4;

        ctx.fillStyle = color;
        ctx.fillRect(x1, y, Math.max(x2 - x1, 1), barH);
      }

      // Draw connecting lines between stages
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1;
      for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1];
        const curr = data[i];
        const prevLevel = STAGE_Y[prev.stage] ?? 2;
        const currLevel = STAGE_Y[curr.stage] ?? 2;
        if (prevLevel !== currLevel) {
          const prevEnd = new Date(prev.ts).getTime() + prev.duration_seconds * 1000;
          const x = ((prevEnd - firstTime) / totalMs) * w;
          const y1 = padTop + prevLevel * laneH + laneH / 2;
          const y2 = padTop + currLevel * laneH + laneH / 2;
          ctx.beginPath();
          ctx.moveTo(x, y1);
          ctx.lineTo(x, y2);
          ctx.stroke();
        }
      }

      // Time labels
      const fmt = (ms: number) => {
        const d = new Date(ms);
        return d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
      };
      const labelCount = 6;
      this.timeLabels = [];
      for (let i = 0; i <= labelCount; i++) {
        this.timeLabels.push(fmt(firstTime + (totalMs * i) / labelCount));
      }
    });
  }
}
