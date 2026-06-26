import { DecimalPipe } from '@angular/common';
import { Component, type OnDestroy, type OnInit, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from './api.service';
import {
	type Measurement,
	RANGE_OPTIONS,
	ROOM_COLORS,
	type RangeKey,
	aqiBand,
	cleanVoc,
} from './measurement.model';
import { RelativeTimePipe } from './relative-time.pipe';
import { ThemeService } from './theme.service';
import { type ChartSeries, type TrendPoint, TrendChart } from './trend-chart/trend-chart';

@Component({
	selector: 'app-root',
	imports: [
		DecimalPipe,
		MatToolbarModule,
		MatButtonModule,
		MatButtonToggleModule,
		MatCardModule,
		MatIconModule,
		MatTooltipModule,
		MatProgressBarModule,
		RelativeTimePipe,
		TrendChart,
	],
	templateUrl: './app.html',
	styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
	private readonly api = inject(ApiService);
	protected readonly theme = inject(ThemeService);

	protected readonly ranges = RANGE_OPTIONS;

	protected readonly devices = this.api.devices;
	protected readonly airDevice = this.api.airDevice;
	protected readonly devicesError = this.api.devicesError;
	protected readonly historyLoading = this.api.historyLoading;
	protected readonly range = this.api.range;
	protected readonly isEmpty = this.api.isEmpty;

	/** Span of the active range in ms, for chart x-axis sizing. */
	protected readonly spanMs = computed(() => {
		const opt = RANGE_OPTIONS.find((o) => o.key === this.range()) ?? RANGE_OPTIONS[0];
		return opt.hours * 3_600_000;
	});

	protected readonly band = computed(() => aqiBand(this.airDevice()?.aqi_us));
	protected readonly voc = computed(() => cleanVoc(this.airDevice()?.voc_ppb));

	protected readonly themeIcon = computed(() => {
		switch (this.theme.mode()) {
			case 'light':
				return 'light_mode';
			case 'dark':
				return 'dark_mode';
			default:
				return 'brightness_auto';
		}
	});

	protected readonly themeLabel = computed(() => `Theme: ${this.theme.mode()}`);

	// Temperature & humidity: one coloured line per device, for room comparison.
	protected readonly tempSeries = this.climateSeries((m) => m.temp_c);
	protected readonly humiditySeries = this.climateSeries((m) => m.humidity);
	// CO₂ & PM2.5: a single line from the air-quality device only.
	protected readonly co2Series = this.airSeries((m) => m.co2_ppm, 'CO₂', 'var(--chart-co2)');
	protected readonly pm25Series = this.airSeries((m) => m.pm25, 'PM2.5', 'var(--chart-pm)');

	ngOnInit(): void {
		this.api.start();
	}

	ngOnDestroy(): void {
		this.api.stop();
	}

	protected onRange(key: RangeKey): void {
		this.api.setRange(key);
	}

	protected toggleTheme(): void {
		this.theme.toggle();
	}

	/** Project a device's history rows onto `TrendPoint`s, dropping null values. */
	private points(rows: Measurement[], pick: (m: Measurement) => number | null): TrendPoint[] {
		const out: TrendPoint[] = [];
		for (const m of rows) {
			const y = pick(m);
			if (y == null) {
				continue;
			}
			const x = new Date(m.ts).getTime();
			if (!Number.isNaN(x)) {
				out.push({ x, y });
			}
		}
		return out;
	}

	/** One coloured line per device (UI order) for a climate metric. */
	private climateSeries(pick: (m: Measurement) => number | null): () => ChartSeries[] {
		return computed(() => {
			const history = this.api.historyByDevice();
			return this.devices().map((d, i) => ({
				label: d.label.name,
				color: ROOM_COLORS[i % ROOM_COLORS.length],
				points: this.points(history[d.device] ?? [], pick),
			}));
		});
	}

	/** A single line from the air-quality device for an air metric. */
	private airSeries(
		pick: (m: Measurement) => number | null,
		label: string,
		color: string,
	): () => ChartSeries[] {
		return computed(() => {
			const air = this.airDevice();
			if (!air) {
				return [];
			}
			const rows = this.api.historyByDevice()[air.device] ?? [];
			return [{ label, color, points: this.points(rows, pick) }];
		});
	}
}
