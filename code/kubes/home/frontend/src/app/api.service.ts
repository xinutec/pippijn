import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { type Measurement, type RangeKey, RANGE_OPTIONS } from './measurement.model';

const LATEST_REFRESH_MS = 60_000;
const DEVICE = 'airvisual';

/**
 * Single data layer for the dashboard. Holds the latest reading and the
 * selected history range as signals, drives a 60s auto-refresh of `/api/latest`,
 * and re-queries `/api/measurements` whenever the range changes.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
	private readonly http = inject(HttpClient);

	private readonly _latest = signal<Measurement | null>(null);
	private readonly _latestLoaded = signal(false);
	private readonly _latestError = signal<string | null>(null);

	private readonly _history = signal<Measurement[]>([]);
	private readonly _historyLoading = signal(false);
	private readonly _historyError = signal<string | null>(null);

	private readonly _range = signal<RangeKey>('24h');

	/** Most recent reading, or `null` when no data exists yet. */
	readonly latest = this._latest.asReadonly();
	/** True once the first `/api/latest` response has been handled. */
	readonly latestLoaded = this._latestLoaded.asReadonly();
	readonly latestError = this._latestError.asReadonly();

	/** Oldest-first readings for the currently selected range. */
	readonly history = this._history.asReadonly();
	readonly historyLoading = this._historyLoading.asReadonly();
	readonly historyError = this._historyError.asReadonly();

	readonly range = this._range.asReadonly();

	/** True when the API has confirmed there is genuinely no data to show. */
	readonly isEmpty = computed(
		() => this._latestLoaded() && this._latest() === null && this._history().length === 0,
	);

	private timer: ReturnType<typeof setInterval> | null = null;

	/** Begin auto-refreshing latest and load the initial history. */
	start(): void {
		void this.refreshLatest();
		void this.refreshHistory();
		this.timer ??= setInterval(() => void this.refreshLatest(), LATEST_REFRESH_MS);
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

	async refreshLatest(): Promise<void> {
		try {
			const row = await firstValueFrom(this.http.get<Measurement | null>('/api/latest'));
			this._latest.set(row ?? null);
			this._latestError.set(null);
		} catch {
			this._latestError.set('Could not reach the sensor service.');
		} finally {
			this._latestLoaded.set(true);
		}
	}

	async refreshHistory(): Promise<void> {
		const opt = RANGE_OPTIONS.find((o) => o.key === this._range()) ?? RANGE_OPTIONS[0];
		const to = new Date();
		const from = new Date(to.getTime() - opt.hours * 3_600_000);
		const params = new HttpParams()
			.set('from', from.toISOString())
			.set('to', to.toISOString())
			.set('device', DEVICE)
			.set('limit', '20000');

		this._historyLoading.set(true);
		try {
			const rows = await firstValueFrom(
				this.http.get<Measurement[]>('/api/measurements', { params }),
			);
			this._history.set(rows ?? []);
			this._historyError.set(null);
		} catch {
			this._historyError.set('Could not load history.');
		} finally {
			this._historyLoading.set(false);
		}
	}
}
