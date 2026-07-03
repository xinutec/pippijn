import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
	type DeviceLatest,
	type Measurement,
	RANGE_OPTIONS,
	type RangeKey,
} from './measurement.model';

const LATEST_REFRESH_MS = 60_000;

/**
 * Single data layer for the dashboard. Holds the latest reading per device and
 * the per-device history for the selected range as signals, drives a 60s
 * auto-refresh of `/api/devices`, and re-queries history whenever the range
 * changes.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
	private readonly http = inject(HttpClient);

	private readonly _devices = signal<DeviceLatest[]>([]);
	private readonly _devicesLoaded = signal(false);
	private readonly _devicesError = signal<string | null>(null);

	private readonly _historyByDevice = signal<Record<string, Measurement[]>>({});
	private readonly _historyLoading = signal(false);
	private readonly _historyError = signal<string | null>(null);

	private readonly _range = signal<RangeKey>('24h');

	/** Latest reading per device, UI-ordered (air-quality sensor first). */
	readonly devices = this._devices.asReadonly();
	/** True once the first `/api/devices` response has been handled. */
	readonly devicesLoaded = this._devicesLoaded.asReadonly();
	readonly devicesError = this._devicesError.asReadonly();

	/** The whole-home air-quality sensor (CO₂/PM/AQI), or `null` if absent. */
	readonly airDevice = computed(() => this._devices().find((d) => d.label.airQuality) ?? null);

	/** Oldest-first readings for the selected range, keyed by device id. */
	readonly historyByDevice = this._historyByDevice.asReadonly();
	readonly historyLoading = this._historyLoading.asReadonly();
	readonly historyError = this._historyError.asReadonly();

	readonly range = this._range.asReadonly();

	/** True when the API has confirmed there is genuinely no data to show. */
	readonly isEmpty = computed(() => this._devicesLoaded() && this._devices().length === 0);

	private timer: ReturnType<typeof setInterval> | null = null;

	// Guards against out-of-order history responses: a slow in-flight fetch for
	// the previous range must not overwrite the newer range's data when it lands.
	private historyGeneration = 0;

	/** Load devices + history, then auto-refresh both on a timer. */
	start(): void {
		void this.init();
		this.timer ??= setInterval(() => {
			void this.refreshDevices();
			// Quiet so the charts stay live without flashing the progress bar.
			void this.refreshHistory(true);
		}, LATEST_REFRESH_MS);
	}

	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Change the active history window and refetch. */
	setRange(range: RangeKey): void {
		if (range === this._range()) {
			return;
		}
		this._range.set(range);
		void this.refreshHistory();
	}

	private async init(): Promise<void> {
		await this.refreshDevices();
		await this.refreshHistory();
	}

	async refreshDevices(): Promise<void> {
		try {
			const rows = await firstValueFrom(this.http.get<DeviceLatest[]>('/api/devices'));
			this._devices.set(rows ?? []);
			this._devicesError.set(null);
		} catch {
			this._devicesError.set('Could not reach the sensor service.');
		} finally {
			this._devicesLoaded.set(true);
		}
	}

	async refreshHistory(quiet = false): Promise<void> {
		const generation = ++this.historyGeneration;
		const devices = this._devices().map((d) => d.device);
		if (devices.length === 0) {
			this._historyByDevice.set({});
			return;
		}
		const opt = RANGE_OPTIONS.find((o) => o.key === this._range()) ?? RANGE_OPTIONS[0];
		const to = new Date();
		const from = new Date(to.getTime() - opt.hours * 3_600_000);

		if (!quiet) {
			this._historyLoading.set(true);
		}
		try {
			const entries = await Promise.all(
				devices.map(async (device) => {
					const params = new HttpParams()
						.set('from', from.toISOString())
						.set('to', to.toISOString())
						.set('device', device)
						.set('limit', '20000');
					const rows = await firstValueFrom(
						this.http.get<Measurement[]>('/api/measurements', { params }),
					);
					return [device, rows ?? []] as const;
				}),
			);
			if (generation !== this.historyGeneration) {
				return; // A newer refresh superseded this one; drop the stale result.
			}
			this._historyByDevice.set(Object.fromEntries(entries));
			this._historyError.set(null);
		} catch {
			if (generation === this.historyGeneration) {
				this._historyError.set('Could not load history.');
			}
		} finally {
			if (!quiet && generation === this.historyGeneration) {
				this._historyLoading.set(false);
			}
		}
	}
}
