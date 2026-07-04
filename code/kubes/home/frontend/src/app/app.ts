import { DecimalPipe } from '@angular/common';
import { Component, type OnDestroy, type OnInit, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from './api.service';
import {
	type DeviceLatest,
	RANGE_OPTIONS,
	ROOM_COLORS,
	type RangeKey,
	aqiBand,
	cleanVoc,
} from './measurement.model';
import { RelativeTimePipe } from './relative-time.pipe';
import { airSeries, climateSeries } from './series';
import { ThemeService } from './theme.service';
import { TrendChart } from './trend-chart/trend-chart';

// localStorage can be unavailable or non-functional (private mode, SSR, and the
// jsdom test env, whose opaque-origin Storage lacks a callable getItem) — guard it.
function readLocal(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function writeLocal(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* no persistent storage available */
	}
}

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
		MatSlideToggleModule,
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
	protected readonly historyError = this.api.historyError;
	protected readonly range = this.api.range;
	protected readonly isEmpty = this.api.isEmpty;

	// Ticks every 30s so the "updated … ago" labels keep counting even when no
	// new reading arrives (a quiet sensor should visibly go stale).
	protected readonly now = signal(Date.now());
	private nowTimer: ReturnType<typeof setInterval> | null = null;

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

	// Apply per-device calibration offsets client-side; toggleable, on by default,
	// remembered across reloads. The DB and API are raw.
	protected readonly calibrated = signal(readLocal('calibrated') !== 'off');

	// Temperature & humidity: one coloured line per device, for room comparison.
	protected readonly tempSeries = computed(() =>
		climateSeries(
			this.devices(),
			this.api.historyByDevice(),
			(m) => m.temp_c,
			(d) => this.off(d, 'temp_c'),
		),
	);
	protected readonly humiditySeries = computed(() =>
		climateSeries(
			this.devices(),
			this.api.historyByDevice(),
			(m) => m.humidity,
			(d) => this.off(d, 'humidity'),
		),
	);
	// Hero (air-quality device) calibrated temp/humidity.
	protected readonly airTemp = computed(() => {
		const a = this.airDevice();
		return a ? this.calTemp(a) : null;
	});
	protected readonly airHum = computed(() => {
		const a = this.airDevice();
		return a ? this.calHum(a) : null;
	});
	// CO₂ & PM2.5: a single line from the air-quality device only.
	protected readonly co2Series = computed(() =>
		airSeries(
			this.devices(),
			this.api.historyByDevice(),
			'CO₂',
			'var(--chart-co2)',
			(m) => m.co2_ppm,
		),
	);
	protected readonly pm25Series = computed(() =>
		airSeries(
			this.devices(),
			this.api.historyByDevice(),
			'PM2.5',
			'var(--chart-pm)',
			(m) => m.pm25,
		),
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
		this.nowTimer ??= setInterval(() => this.now.set(Date.now()), 30_000);
	}

	ngOnDestroy(): void {
		this.api.stop();
		if (this.nowTimer !== null) {
			clearInterval(this.nowTimer);
			this.nowTimer = null;
		}
	}

	protected onRange(key: RangeKey): void {
		this.api.setRange(key);
	}

	protected toggleTheme(): void {
		this.theme.toggle();
	}

	protected toggleCalibrated(): void {
		const v = !this.calibrated();
		this.calibrated.set(v);
		writeLocal('calibrated', v ? 'on' : 'off');
	}

	/** Offset to add to a device's reading for `key`; 0 when calibration is off/absent. */
	private off(d: DeviceLatest, key: 'temp_c' | 'humidity'): number {
		const v = d.offset?.[key];
		return this.calibrated() && v != null ? v : 0;
	}

	/** A device's calibrated temperature (raw when calibration is off). */
	protected calTemp(d: DeviceLatest): number | null {
		return d.temp_c != null ? d.temp_c + this.off(d, 'temp_c') : null;
	}

	protected calHum(d: DeviceLatest): number | null {
		return d.humidity != null ? d.humidity + this.off(d, 'humidity') : null;
	}

	/**
	 * Chart line colour for the device at index `i`. The room cards iterate the
	 * same `devices()` array in the same order as the climate charts, which colour
	 * series `i` with `ROOM_COLORS[i]` — so a card's name matches its chart line.
	 */
	protected roomColor(i: number): string {
		return ROOM_COLORS[i % ROOM_COLORS.length];
	}
}
