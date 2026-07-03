import {
	type AfterViewInit,
	Component,
	type ElementRef,
	type OnDestroy,
	computed,
	effect,
	inject,
	input,
	viewChild,
} from '@angular/core';
import {
	Chart,
	type ChartConfiguration,
	Filler,
	Legend,
	LineController,
	LineElement,
	LinearScale,
	PointElement,
	TimeScale,
	Tooltip,
	type TooltipItem,
} from 'chart.js';
import 'chartjs-adapter-date-fns';
import { ThemeService } from '../theme.service';

Chart.register(
	LineController,
	LineElement,
	PointElement,
	LinearScale,
	TimeScale,
	Filler,
	Legend,
	Tooltip,
);

export interface TrendPoint {
	x: number;
	y: number;
}

/** One named line on the chart. `color` is any CSS value (incl. `var(--…)`). */
export interface ChartSeries {
	label: string;
	color: string;
	/** Oldest-first data points. */
	points: TrendPoint[];
}

/**
 * Standalone wrapper around a Chart.js line chart that draws one or more series.
 * A single series keeps the filled-gradient look; multiple series drop the fill
 * and show a legend, for room-to-room comparison. Colours resolve from the
 * Material 3 system CSS variables so the chart tracks the active theme.
 */
@Component({
	selector: 'app-trend-chart',
	templateUrl: './trend-chart.html',
	styleUrl: './trend-chart.scss',
})
export class TrendChart implements AfterViewInit, OnDestroy {
	private readonly theme = inject(ThemeService);
	private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

	readonly title = input.required<string>();
	readonly unit = input<string>('');
	/** One or more series to plot. */
	readonly series = input.required<ChartSeries[]>();
	/** Number of decimal places to show in the tooltip. */
	readonly decimals = input<number>(0);
	readonly spanMs = input<number>(24 * 3_600_000);

	private chart: Chart<'line', TrendPoint[]> | null = null;
	private ready = false;

	readonly hasData = computed(() => this.series().some((s) => s.points.length > 0));

	constructor() {
		// Redraw on data, theme, or range changes.
		effect(() => {
			// Track dependencies.
			this.series();
			this.theme.effective();
			this.spanMs();
			if (this.ready) {
				this.render();
			}
		});
	}

	ngAfterViewInit(): void {
		this.ready = true;
		this.render();
	}

	ngOnDestroy(): void {
		this.chart?.destroy();
		this.chart = null;
	}

	private resolve(cssValue: string): string {
		const el = this.canvas().nativeElement;
		const probe = document.createElement('span');
		probe.style.color = cssValue;
		probe.style.display = 'none';
		el.parentElement?.appendChild(probe);
		const resolved = getComputedStyle(probe).color;
		probe.remove();
		return resolved || '#26a69a';
	}

	private withAlpha(rgb: string, alpha: number): string {
		const m = rgb.match(/rgba?\(([^)]+)\)/);
		if (!m) {
			return rgb;
		}
		const [r, g, b] = m[1].split(',').map((s) => s.trim());
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}

	private render(): void {
		const el = this.canvas().nativeElement;
		const ctx = el.getContext('2d');
		if (!ctx) {
			return;
		}

		const grid = this.withAlpha(this.resolve('var(--mat-sys-outline-variant)'), 0.5);
		const text = this.resolve('var(--mat-sys-on-surface-variant)');

		const series = this.series();
		const multi = series.length > 1;

		const datasets = series.map((s) => {
			const color = this.resolve(s.color);
			let background: string | CanvasGradient = this.withAlpha(color, 0);
			if (!multi) {
				const gradient = ctx.createLinearGradient(0, 0, 0, el.height || 220);
				gradient.addColorStop(0, this.withAlpha(color, 0.35));
				gradient.addColorStop(1, this.withAlpha(color, 0));
				background = gradient;
			}
			return {
				label: s.label,
				data: s.points,
				borderColor: color,
				backgroundColor: background,
				borderWidth: 2,
				fill: !multi,
				tension: 0.35,
				pointRadius: 0,
				pointHoverRadius: 4,
				pointHoverBackgroundColor: color,
				spanGaps: true,
			};
		});

		const decimals = this.decimals();
		const unit = this.unit();
		// Renders happen right after a fetch, so "now" matches the window the
		// data was queried with closely enough to anchor the axis.
		const now = Date.now();

		const config: ChartConfiguration<'line', TrendPoint[]> = {
			type: 'line',
			data: { datasets },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				// Debounce transient resizes (e.g. a backgrounded tab re-measuring at
				// 0px) so a brief bad size doesn't trigger a shrink.
				resizeDelay: 200,
				animation: { duration: 350 },
				interaction: { mode: 'index', intersect: false },
				plugins: {
					legend: {
						display: multi,
						position: 'bottom',
						labels: {
							color: text,
							boxWidth: 8,
							boxHeight: 8,
							usePointStyle: true,
							font: { size: 11 },
						},
					},
					tooltip: {
						displayColors: multi,
						callbacks: {
							label: (item: TooltipItem<'line'>) => {
								const value = `${Number(item.parsed.y).toFixed(decimals)}${unit ? ` ${unit}` : ''}`;
								return multi ? `${item.dataset.label}: ${value}` : value;
							},
						},
					},
				},
				scales: {
					x: {
						type: 'time',
						// Pin the axis to the selected range (now − span … now) so a
						// "30 d" chart spans 30 days even when the data is sparse,
						// instead of auto-fitting the data extent.
						min: now - this.spanMs(),
						max: now,
						time: { tooltipFormat: 'PPp' },
						grid: { display: false },
						border: { display: false },
						ticks: {
							color: text,
							maxRotation: 0,
							autoSkip: true,
							maxTicksLimit: 6,
							font: { size: 11 },
						},
					},
					y: {
						grid: { color: grid },
						border: { display: false },
						ticks: { color: text, maxTicksLimit: 5, font: { size: 11 } },
					},
				},
			},
		};

		if (this.chart) {
			this.chart.data = config.data;
			if (config.options) {
				this.chart.options = config.options;
			}
			this.chart.update();
		} else {
			this.chart = new Chart(ctx, config);
		}
	}
}
