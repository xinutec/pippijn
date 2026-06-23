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
	type RangeKey,
	aqiBand,
	cleanVoc,
} from './measurement.model';
import { RelativeTimePipe } from './relative-time.pipe';
import { ThemeService } from './theme.service';
import { type TrendPoint, TrendChart } from './trend-chart/trend-chart';

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

	protected readonly latest = this.api.latest;
	protected readonly latestLoaded = this.api.latestLoaded;
	protected readonly latestError = this.api.latestError;
	protected readonly history = this.api.history;
	protected readonly historyLoading = this.api.historyLoading;
	protected readonly range = this.api.range;
	protected readonly isEmpty = this.api.isEmpty;

	/** Span of the active range in ms, for chart x-axis sizing. */
	protected readonly spanMs = computed(() => {
		const opt = RANGE_OPTIONS.find((o) => o.key === this.range()) ?? RANGE_OPTIONS[0];
		return opt.hours * 3_600_000;
	});

	protected readonly band = computed(() => aqiBand(this.latest()?.aqi_us));
	protected readonly voc = computed(() => cleanVoc(this.latest()?.voc_ppb));

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

	protected readonly tempPoints = this.series((m) => m.temp_c);
	protected readonly co2Points = this.series((m) => m.co2_ppm);
	protected readonly humidityPoints = this.series((m) => m.humidity);
	protected readonly pm25Points = this.series((m) => m.pm25);

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

	/** Build a reactive `TrendPoint[]` selector over the history signal. */
	private series(pick: (m: Measurement) => number | null): () => TrendPoint[] {
		return computed(() => {
			const out: TrendPoint[] = [];
			for (const m of this.history()) {
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
		});
	}
}
