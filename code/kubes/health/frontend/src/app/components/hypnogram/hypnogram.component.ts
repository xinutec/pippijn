import { Component, input, effect, ElementRef, viewChild } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { SleepStage } from "../../services/health.service";
import { localEpoch } from "../../time-utils";

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
  templateUrl: './hypnogram.component.html',
  styleUrl: './hypnogram.component.scss',
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

      // Compute time range (local time, not UTC)
      const firstTime = localEpoch(data[0].ts);
      const lastStage = data[data.length - 1];
      const lastTime = localEpoch(lastStage.ts) + lastStage.duration_seconds * 1000;
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
        const stageStart = localEpoch(stage.ts);
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
          const prevEnd = localEpoch(prev.ts) + prev.duration_seconds * 1000;
          const x = ((prevEnd - firstTime) / totalMs) * w;
          const y1 = padTop + prevLevel * laneH + laneH / 2;
          const y2 = padTop + currLevel * laneH + laneH / 2;
          ctx.beginPath();
          ctx.moveTo(x, y1);
          ctx.lineTo(x, y2);
          ctx.stroke();
        }
      }

      // Time labels — use formatLocalTime for first/last, interpolate for middle
      const labelCount = 6;
      this.timeLabels = [];
      // For interpolated labels, use the local epoch (already local time)
      for (let i = 0; i <= labelCount; i++) {
        const ms = firstTime + (totalMs * i) / labelCount;
        const d = new Date(ms);
        const hh = d.getHours().toString().padStart(2, "0");
        const mm = d.getMinutes().toString().padStart(2, "0");
        this.timeLabels.push(`${hh}:${mm}`);
      }
    });
  }
}
