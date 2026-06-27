import { Component, ElementRef, type OnDestroy, effect, input, signal, viewChild } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import type { VelocityData } from "../../services/health.service";
import { browserTimezone } from "../../time-utils";
import { batteryMarker, batteryTimeLabels, batteryXRange } from "./battery-chart.logic";

/** Phone-battery level over the day. The series is derived from the
 *  `battery` field PhoneTrack records on each GPS fix, compressed to
 *  run boundaries server-side (see `batterySeries` in velocity.ts).
 *  Canvas rendering mirrors the speed chart — same hi-DPI sizing and
 *  ResizeObserver redraw so a day switched on a hidden tab still
 *  paints when the tab is shown. */
@Component({
	selector: "app-battery-chart",
	standalone: true,
	imports: [MatCardModule],
	templateUrl: "./battery-chart.component.html",
	styleUrl: "./battery-chart.component.scss",
})
export class BatteryChartComponent implements OnDestroy {
	readonly data = input<VelocityData | null>(null);
	readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>("canvas");
	timeLabels: string[] = [];

	/** Bumped by the ResizeObserver to re-run the draw effect when the
	 *  canvas resizes — including 0→visible after this tab is shown. */
	private readonly redrawTick = signal(0);
	private resizeObs: ResizeObserver | null = null;

	/** True once `data()` has resolved to a non-empty series — drives
	 *  the "no data" placeholder vs the canvas in the template. */
	hasData = false;

	constructor() {
		effect(() => {
			this.redrawTick();
			const battery = this.data()?.battery ?? [];
			this.hasData = battery.length > 0;
			const canvasEl = this.canvasRef();
			if (canvasEl && !this.resizeObs) {
				this.resizeObs = new ResizeObserver(() => this.redrawTick.update((n) => n + 1));
				this.resizeObs.observe(canvasEl.nativeElement.parentElement ?? canvasEl.nativeElement);
			}
			if (battery.length === 0 || !canvasEl) return;

			const canvas = canvasEl.nativeElement;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;

			const range = batteryXRange(battery);
			if (!range) return;
			const { firstTs, lastTs, totalDuration } = range;

			const dpr = window.devicePixelRatio || 1;
			const rect = canvas.getBoundingClientRect();
			canvas.width = rect.width * dpr;
			canvas.height = rect.height * dpr;
			ctx.scale(dpr, dpr);
			const w = rect.width;
			const h = rect.height;

			const padTop = 20;
			const padBottom = 8;
			const padLeft = 40;
			// Headroom on the right so the end-of-day "NN%" label fits.
			const padRight = 34;
			const drawW = w - padLeft - padRight;
			const drawH = h - padTop - padBottom;

			const xPos = (ts: number): number => padLeft + ((ts - firstTs) / totalDuration) * drawW;
			// Battery is a percentage — the Y axis is always a fixed 0–100.
			const yPos = (level: number): number => padTop + drawH - (level / 100) * drawH;

			ctx.clearRect(0, 0, w, h);

			// Y-axis grid lines + labels at every 25%.
			ctx.strokeStyle = "rgba(255,255,255,0.08)";
			ctx.fillStyle = "rgba(255,255,255,0.4)";
			ctx.font = "11px sans-serif";
			ctx.textAlign = "right";
			for (let level = 0; level <= 100; level += 25) {
				const y = yPos(level);
				ctx.beginPath();
				ctx.moveTo(padLeft, y);
				ctx.lineTo(w - padRight, y);
				ctx.stroke();
				ctx.fillText(`${level}`, padLeft - 4, y + 4);
			}

			// Filled area under the level line, then the line on top.
			const green = "#22c55e";
			ctx.beginPath();
			for (let i = 0; i < battery.length; i++) {
				const x = xPos(battery[i].ts);
				const y = yPos(battery[i].level);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			const lineEndX = xPos(lastTs);
			ctx.lineTo(lineEndX, yPos(0));
			ctx.lineTo(xPos(firstTs), yPos(0));
			ctx.closePath();
			ctx.fillStyle = "rgba(34, 197, 94, 0.14)";
			ctx.fill();

			ctx.strokeStyle = green;
			ctx.lineWidth = 1.75;
			ctx.lineJoin = "round";
			ctx.beginPath();
			for (let i = 0; i < battery.length; i++) {
				const x = xPos(battery[i].ts);
				const y = yPos(battery[i].level);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.stroke();

			// Mark the latest reading: a dot plus its level, so the
			// end-of-day charge is readable at a glance.
			const last = batteryMarker(battery) ?? battery[battery.length - 1];
			const lx = xPos(last.ts);
			const ly = yPos(last.level);
			ctx.fillStyle = green;
			ctx.beginPath();
			ctx.arc(lx, ly, 3, 0, Math.PI * 2);
			ctx.fill();
			ctx.textAlign = "left";
			ctx.font = "12px sans-serif";
			ctx.fillText(`${last.level}%`, Math.min(lx + 6, w - padRight + 2), ly + 4);

			// Time labels along the X axis (PhoneTrack timestamps are UTC; render
			// in the viewer's local time zone).
			this.timeLabels = batteryTimeLabels(firstTs, lastTs, 6, browserTimezone());
		});
	}

	ngOnDestroy(): void {
		this.resizeObs?.disconnect();
	}
}
