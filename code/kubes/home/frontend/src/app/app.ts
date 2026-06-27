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
import { RANGE_OPTIONS, type RangeKey, aqiBand, cleanVoc } from './measurement.model';
import { RelativeTimePipe } from './relative-time.pipe';
import { airSeries, climateSeries } from './series';
import { ThemeService } from './theme.service';
import { TrendChart } from './trend-chart/trend-chart';

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
	protected readonly tempSeries = computed(() =>
		climateSeries(this.devices(), this.api.historyByDevice(), (m) => m.temp_c),
	);
	protected readonly humiditySeries = computed(() =>
		climateSeries(this.devices(), this.api.historyByDevice(), (m) => m.humidity),
	);
	// CO₂ & PM2.5: a single line from the air-quality device only.
	protected readonly co2Series = computed(() =>
		airSeries(this.devices(), this.api.historyByDevice(), 'CO₂', 'var(--chart-co2)', (m) => m.co2_ppm),
	);
	protected readonly pm25Series = computed(() =>
		airSeries(this.devices(), this.api.historyByDevice(), 'PM2.5', 'var(--chart-pm)', (m) => m.pm25),
	);
	// Bluetooth signal (dBm): one line per device that reports rssi (the Govee
	// sensors); empty series (e.g. the wired IQAir) are dropped.
	protected readonly rssiSeries = computed(() =>
		climateSeries(this.devices(), this.api.historyByDevice(), (m) => m.rssi).filter(
			(s) => s.points.length > 0,
		),
	);

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
}
