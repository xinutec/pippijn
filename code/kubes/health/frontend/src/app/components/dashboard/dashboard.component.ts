import { Component, OnDestroy, OnInit, computed, effect, inject, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { Subscription } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatTabsModule } from "@angular/material/tabs";
import {
	type ActivityDay,
	HealthService,
	type HeartRatePoint,
	type LatestFix,
	type SleepLog,
	type SleepStage,
	type VelocityData,
} from "../../services/health.service";
import { browserTimezone, formatDateInTz, todayLocal } from "../../time-utils";

/** How often to poll for the latest PhoneTrack fix while today's Map
 *  tab is open. */
const LIVE_POLL_MS = 15_000;

/** localStorage key for the last live fix — lets the Map tab show a
 *  position immediately after a reload, before the first poll. */
const LIVE_FIX_CACHE_KEY = "health:live-fix";
import { logBootContext } from "../../client-diagnostics";
import { DayNavComponent } from "../day-nav/day-nav.component";
import { HeartrateChartComponent } from "../heartrate-chart/heartrate-chart.component";
import { HypnogramComponent } from "../hypnogram/hypnogram.component";
import { IntradayHrComponent } from "../intraday-hr/intraday-hr.component";
import { MapComponent } from "../map/map.component";
import { SleepChartComponent } from "../sleep-chart/sleep-chart.component";
import { SpeedChartComponent } from "../speed-chart/speed-chart.component";
import { StepsChartComponent } from "../steps-chart/steps-chart.component";
import { SummaryCardsComponent } from "../summary-cards/summary-cards.component";
import { TimelineComponent } from "../timeline/timeline.component";

/**
 * Day + Trends tabs. Used by both `/` (owner) and `/share/:token`
 * (recipient) — the only difference is the route param.
 *
 * Mode handling:
 *   - If the route has a `:token` param, the share token is stashed
 *     on `HealthService` so every API call carries `X-Share-Token`.
 *     Server-side gating enforces read-only + date-window.
 *   - All day-nav navigation uses Router with `relativeTo: this.route`,
 *     which preserves the active path verbatim. So `share/:token`
 *     stays in the URL while only `?date=` changes.
 */
@Component({
	selector: "app-dashboard",
	standalone: true,
	imports: [
		MatButtonModule,
		MatProgressSpinnerModule,
		MatTabsModule,
		DayNavComponent,
		SummaryCardsComponent,
		HypnogramComponent,
		IntradayHrComponent,
		SpeedChartComponent,
		TimelineComponent,
		MapComponent,
		StepsChartComponent,
		HeartrateChartComponent,
		SleepChartComponent,
	],
	templateUrl: "./dashboard.component.html",
	styleUrl: "./dashboard.component.scss",
})
export class DashboardComponent implements OnInit, OnDestroy {
	readonly view = signal<"today" | "trends" | "map">("today");
	/** Tab index for `<mat-tab-group [selectedIndex]>`, derived from `view`. */
	readonly tabIndex = computed(() => (this.view() === "today" ? 0 : this.view() === "trends" ? 1 : 2));
	readonly selectedDate = signal(todayLocal());
	readonly activity = signal<ActivityDay[]>([]);
	readonly sleep = signal<SleepLog[]>([]);
	readonly sleepStages = signal<SleepStage[]>([]);
	readonly intradayHr = signal<HeartRatePoint[]>([]);
	readonly velocity = signal<VelocityData | null>(null);
	readonly latestActivity = signal<ActivityDay | null>(null);
	readonly latestSleep = signal<SleepLog | null>(null);
	readonly authenticated = signal(false);
	readonly fitbitLinked = signal(false);
	readonly loading = signal(true);
	readonly dayLoading = signal(false);
	/** Most recent PhoneTrack fix — drives the Map tab's live marker.
	 *  Owned here, not in MapComponent, so it survives the Map tab
	 *  being torn down and rebuilt on each visit. */
	readonly liveFix = signal<LatestFix | null>(null);

	readonly health = inject(HealthService);
	private readonly route = inject(ActivatedRoute);
	private readonly router = inject(Router);
	private querySub: Subscription | null = null;

	/** True iff this dashboard instance is rendering a share URL.
	 *  Set in ngOnInit from the route's `:token` param. */
	private isShareView = false;

	constructor() {
		// Seed the live marker from the last cached fix so the Map tab
		// shows a position immediately on load — before the first poll
		// returns — rather than snapping in from the path's end.
		const cached = this.readCachedFix();
		if (cached) this.liveFix.set(cached);

		// Poll for the latest PhoneTrack fix while today's Map tab is
		// open. This lives on the dashboard, not MapComponent: the Map
		// tab is lazily (re)created on every visit, so holding the fix
		// here is what stops it resetting — and flickering — on each
		// tab switch.
		effect((onCleanup) => {
			if (!this.isToday()) {
				// A past day has no live marker.
				this.liveFix.set(null);
				return;
			}
			// Off the Map tab: keep the last fix, just stop polling.
			if (this.view() !== "map") return;
			const poll = (): void => {
				void this.health.getLatestFix().then((f) => {
					this.liveFix.set(f);
					if (f) this.cacheLiveFix(f);
				});
			};
			poll();
			const id = setInterval(poll, LIVE_POLL_MS);
			onCleanup(() => clearInterval(id));
		});
	}

	/** Read the last live fix from localStorage. Honoured only when it
	 *  is from today — the live marker is a "today" concept, and a
	 *  stale fix shown with just a time-of-day would mislead. */
	private readCachedFix(): LatestFix | null {
		try {
			const raw = localStorage.getItem(LIVE_FIX_CACHE_KEY);
			if (raw === null) return null;
			const f = JSON.parse(raw) as LatestFix;
			if (typeof f?.lat !== "number" || typeof f?.lon !== "number" || typeof f?.ts !== "number") {
				return null;
			}
			if (formatDateInTz(new Date(f.ts * 1000), browserTimezone()) !== todayLocal()) return null;
			return f;
		} catch {
			return null;
		}
	}

	/** Persist the latest fix so a reload can seed the marker before
	 *  the first poll. Silent if localStorage is unavailable. */
	private cacheLiveFix(f: LatestFix): void {
		try {
			localStorage.setItem(LIVE_FIX_CACHE_KEY, JSON.stringify(f));
		} catch {
			// localStorage disabled (private mode) — in-memory state
			// still works; only cross-reload memory is lost.
		}
	}

	/** Validate a `?date=YYYY-MM-DD` query parameter. Rejects
	 *  malformed strings and future dates (the timeline never
	 *  renders future days). */
	private parseDateParam(raw: string | null): string | null {
		if (raw === null) return null;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
		if (raw > todayLocal()) return null;
		return raw;
	}

	/** Validate a `?tab=` query parameter. Null (absent or junk) lets
	 *  the caller fall back to the default tab. */
	private parseTabParam(raw: string | null): "today" | "trends" | "map" | null {
		return raw === "today" || raw === "trends" || raw === "map" ? raw : null;
	}

	async ngOnInit(): Promise<void> {
		// Share mode: stash the route's `:token` param onto HealthService
		// so every API call carries `X-Share-Token`. The rest of the
		// dashboard runs identically; server-side gates enforce
		// read-only + date-window.
		const token = this.route.snapshot.paramMap.get("token");
		if (token) {
			this.isShareView = true;
			this.health.shareToken.set(token);
		}

		const ok = await this.health.checkAuth();
		this.authenticated.set(ok);
		if (!ok) {
			this.loading.set(false);
			return;
		}

		// One-shot boot context (UA, viewport, tz, locale) for future
		// bug-correlation. Owner mode only — share-viewer's POST would
		// 403 and the diagnostics are about the OWNER's environment.
		if (!this.isShareView) logBootContext(this.health);

		this.fitbitLinked.set(this.health.user()?.fitbitLinked ?? false);
		if (!this.fitbitLinked()) {
			this.loading.set(false);
			return;
		}

		// Restore the day from `?date=YYYY-MM-DD` on first paint so reload
		// stays on the day the user navigated to.
		const initial = this.parseDateParam(this.route.snapshot.queryParamMap.get("date"));
		if (initial !== null) this.selectedDate.set(initial);

		// Restore the active tab from `?tab=` so reload — and share
		// links like `/share/<token>?tab=map` — open on the right tab.
		const initialTab = this.parseTabParam(this.route.snapshot.queryParamMap.get("tab"));
		if (initialTab !== null) this.view.set(initialTab);

		// React to query-param changes the app did not initiate itself:
		// browser back/forward and direct URL edits. Chevron clicks go
		// through changeDay, which applies the day directly — the guard
		// below then makes this a no-op for them.
		this.querySub = this.route.queryParamMap.subscribe((params) => {
			// Tab changes (incl. browser back/forward) are cheap — just
			// switch the view, no data reload.
			const tab = this.parseTabParam(params.get("tab"));
			if (tab !== null && tab !== this.view()) this.view.set(tab);
			// Date changes trigger a data reload via goToDay.
			const next = this.parseDateParam(params.get("date")) ?? todayLocal();
			if (next === this.selectedDate()) return;
			void this.goToDay(next);
		});

		// Fire-and-forget: keep PhoneTrack's visualisation filter aligned
		// with "today from 00:00 (or yesterday after midnight before
		// 06:00)". Skip in share mode — the backend 403s, and the
		// recipient has no business touching the owner's PhoneTrack
		// prefs.
		if (!this.isShareView) {
			void this.health.syncPhoneTrackFilter();
		}

		await this.loadData();
		this.loading.set(false);
	}

	ngOnDestroy(): void {
		this.querySub?.unsubscribe();
	}

	async loadData(): Promise<void> {
		const date = this.selectedDate();
		try {
			const [activity, sleep, stages, hrIntraday, velocity] = await Promise.all([
				this.health.getActivity(30),
				this.health.getSleep(30),
				this.health.getSleepStages(date),
				this.health.getHeartRateIntraday(date),
				this.health.getVelocity(date).catch(() => null),
			]);

			// A burst of day-navigation fires overlapping loadData calls.
			// If the user moved to another day while these requests were
			// in flight, drop this now-stale batch instead of letting it
			// overwrite the current day's data.
			if (this.selectedDate() !== date) return;

			this.activity.set(activity);
			this.sleep.set(sleep);
			this.sleepStages.set(stages);
			this.intradayHr.set(hrIntraday);
			this.velocity.set(velocity);

			// Show only data that actually belongs to the selected
			// date — no silent fallback to "the latest". An empty card
			// is correct when today's data hasn't synced yet.
			const dayActivity = activity.find((a) => a.date.startsWith(date));
			this.latestActivity.set(dayActivity ?? null);

			const dayMainSleep = sleep.find((s) => s.is_main_sleep && s.date.startsWith(date));
			this.latestSleep.set(dayMainSleep ?? null);
		} catch (e) {
			console.error("Failed to load data:", e);
		}
	}

	/** Switch the dashboard to `date`: apply it to state immediately,
	 *  then load that day's data. `loadData` discards its own result
	 *  if the user navigates on before it returns, so a fast burst of
	 *  navigation settles on the last day actually selected. */
	private async goToDay(date: string): Promise<void> {
		this.selectedDate.set(date);
		this.dayLoading.set(true);
		try {
			await this.loadData();
		} finally {
			this.dayLoading.set(false);
		}
	}

	changeDay(delta: number): void {
		const d = new Date(this.selectedDate() + "T12:00:00"); // noon to avoid DST edge
		d.setDate(d.getDate() + delta);
		const newDate = formatDateInTz(d, browserTimezone());
		if (newDate > this.rightEdge()) return;
		const left = this.leftEdge();
		if (left !== null && newDate < left) return;
		if (newDate === this.selectedDate()) return;
		// Apply the step immediately so a fast burst of clicks each
		// computes from the correct day, not a stale one.
		void this.goToDay(newDate);
		// Sync the URL too (relativeTo: this.route keeps `/` or
		// `/share/<token>` and only rewrites the query string) so
		// reload / share / browser-back stay in step. The queryParamMap
		// subscription sees selectedDate already at newDate and skips a
		// duplicate load.
		const queryParams = newDate === todayLocal() ? { date: null } : { date: newDate };
		void this.router.navigate([], {
			relativeTo: this.route,
			queryParams,
			queryParamsHandling: "merge",
		});
	}

	/** Switch tabs and mirror the choice into `?tab=` so reload and
	 *  share links keep it. "today" is the default — omitted for a
	 *  clean URL, same as `?date=` omits the current day. */
	changeTab(index: number): void {
		const tab = index === 0 ? "today" : index === 1 ? "trends" : "map";
		this.view.set(tab);
		void this.router.navigate([], {
			relativeTo: this.route,
			queryParams: { tab: tab === "today" ? null : tab },
			queryParamsHandling: "merge",
		});
	}

	isToday(): boolean {
		return this.selectedDate() === todayLocal();
	}

	/** Earliest navigable date. Owner mode: null (no limit). Share
	 *  mode: shareWindow.from. */
	leftEdge(): string | null {
		return this.health.user()?.shareWindow?.from ?? null;
	}

	/** Latest navigable date. Owner mode: today. Share mode:
	 *  min(today, shareWindow.to). */
	rightEdge(): string {
		const win = this.health.user()?.shareWindow;
		const t = todayLocal();
		if (!win) return t;
		return win.to < t ? win.to : t;
	}

	canGoLeft(): boolean {
		const left = this.leftEdge();
		return left === null || this.selectedDate() > left;
	}

	canGoRight(): boolean {
		return this.selectedDate() < this.rightEdge();
	}

	formatDisplayDate(): string {
		const date = this.selectedDate();
		if (date === todayLocal()) return "Today";
		const d = new Date(date + "T12:00:00");
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		if (date === formatDateInTz(yesterday, browserTimezone())) return "Yesterday";
		return d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
	}
}
