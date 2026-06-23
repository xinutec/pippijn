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
	CategoryScale,
	Chart,
	type ChartConfiguration,
	Filler,
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
	CategoryScale,
	TimeScale,
	Filler,
	Tooltip,
);

export interface TrendPoint {
	x: number;
	y: number;
}

/**
 * Standalone wrapper around a single Chart.js line chart. Pulls colours from
 * the Material 3 system CSS variables so it tracks the active light/dark theme,
 * and redraws whenever its inputs or the theme change.
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
	/** Oldest-first data points. */
	readonly points = input.required<TrendPoint[]>();
	/** Base accent colour as a CSS value, e.g. `var(--mat-sys-primary)`. */
	readonly accent = input<string>('var(--mat-sys-primary)');
	/** Number of decimal places to show in the tooltip. */
	readonly decimals = input<number>(0);
	readonly spanMs = input<number>(24 * 3_600_000);

	private chart: Chart<'line', TrendPoint[]> | null = null;
	private ready = false;

	readonly hasData = computed(() => this.points().length > 0);

	constructor() {
		// Redraw on data, theme, or range changes.
		effect(() => {
			// Track dependencies.
			this.points();
			this.accent();
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

		const accent = this.resolve(this.accent());
		const grid = this.withAlpha(this.resolve('var(--mat-sys-outline-variant)'), 0.5);
		const text = this.resolve('var(--mat-sys-on-surface-variant)');

		const gradient = ctx.createLinearGradient(0, 0, 0, el.height || 220);
		gradient.addColorStop(0, this.withAlpha(accent, 0.35));
		gradient.addColorStop(1, this.withAlpha(accent, 0.0));

		const data = this.points();
		const decimals = this.decimals();
		const unit = this.unit();

		const config: ChartConfiguration<'line', TrendPoint[]> = {
			type: 'line',
			data: {
				datasets: [
					{
						data,
						borderColor: accent,
						backgroundColor: gradient,
						borderWidth: 2,
						fill: true,
						tension: 0.35,
						pointRadius: 0,
						pointHoverRadius: 4,
						pointHoverBackgroundColor: accent,
						spanGaps: true,
					},
				],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: { duration: 350 },
				interaction: { mode: 'index', intersect: false },
				plugins: {
					legend: { display: false },
					tooltip: {
						displayColors: false,
						callbacks: {
							label: (item: TooltipItem<'line'>) =>
								`${Number(item.parsed.y).toFixed(decimals)}${unit ? ` ${unit}` : ''}`,
						},
					},
				},
				scales: {
					x: {
						type: 'time',
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
