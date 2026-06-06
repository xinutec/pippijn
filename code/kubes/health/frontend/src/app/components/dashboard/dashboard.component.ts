import { Component, type OnDestroy, type OnInit, computed, effect, inject, resource, signal } from "@angular/core";
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
import { BatteryChartComponent } from "../battery-chart/battery-chart.component";
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
import { selectDayActivity, selectDayMainSleep } from "./day-selection";

/** Per-day payload — the data that changes when you navigate days. */
interface DayData {
	stages: SleepStage[];
	hr: HeartRatePoint[];
	velocity: VelocityData | null;
}

/** Rolling-window payload — the last 30 days of activity + sleep. This
 *  does NOT depend on the selected day, so it is fetched once and the
 *  selected day is derived from it. */
interface WindowData {
	activity: ActivityDay[];
	sleep: SleepLog[];
}

/**
 * Day + Trends + Map tabs. Used by both `/` (owner) and `/share/:token`
 * (recipient) — the only difference is the route param.
 *
 * # State model
 *
 * The selected day is the single source of truth (`selectedDate`). Two
 * `resource()`s derive from it and the auth state:
 *
 *   - `windowData` (activity + sleep, last 30 days) loads once the user
 *     is ready; it is day-independent, so navigation never refetches it.
 *   - `dayData` (sleep stages, intraday HR, velocity) is keyed on
 *     `selectedDate`. When the day changes, the resource supersedes any
 *     in-flight load — aborting it on the wire — and only ever applies
 *     the latest day's result. This is what makes a fast burst of
 *     day-navigation settle on the landed-on day with no stale flash and
 *     no manual race-guarding.
 *
 * Everything the template binds (`velocity()`, `latestSleep()`,
 * `dayLoading()`, …) is a `computed()` over those resources, so view
 * state cannot desync from the data it describes.
 *
 * # URL
 *
 * `selectedDate` / `view` are reflected into `?date=` / `?tab=` by the
 * navigation handlers, and adopted back from the URL on first paint and
 * on browser back/forward. Share mode (`share/:token`) stashes the token
 * on `HealthService` so every API call carries `X-Share-Token`; the
 * server gates read-only + date-window.
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
		BatteryChartComponent,
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

	// Auth / linkage gates. `dataReady` flips true once we know the user
	// is signed in with a linked Fitbit — only then do the resources load.
	readonly authReady = signal(false);
	readonly authenticated = signal(false);
	readonly fitbitLinked = signal(false);
	private readonly dataReady = computed(() => this.authenticated() && this.fitbitLinked());

	readonly health = inject(HealthService);
	private readonly route = inject(ActivatedRoute);
	private readonly router = inject(Router);
	private querySub: Subscription | null = null;

	/** True iff this dashboard instance is rendering a share URL.
	 *  Set in ngOnInit from the route's `:token` param. */
	private isShareView = false;

	/** Last 30 days of activity + sleep. Day-independent: the `params`
	 *  key is constant once ready, so this loads exactly once per session
	 *  rather than on every day-navigation. */
	private readonly windowData = resource<WindowData, "ready" | undefined>({
		// `undefined` keeps the resource idle until the user is ready; a
		// constant key thereafter means it loads exactly once.
		params: () => (this.dataReady() ? "ready" : undefined),
		defaultValue: { activity: [], sleep: [] },
		loader: async ({ abortSignal }) => {
			const [activity, sleep] = await Promise.all([
				this.health.getActivity(30, abortSignal).catch(() => [] as ActivityDay[]),
				this.health.getSleep(30, abortSignal).catch(() => [] as SleepLog[]),
			]);
			return { activity, sleep };
		},
	});

	/** The selected day's stages / intraday HR / velocity. Keyed on the
	 *  day, so it reloads — and supersedes — on navigation. `undefined`
	 *  params keep it idle until the user is ready. */
	private readonly dayData = resource<DayData, string | undefined>({
		params: () => (this.dataReady() ? this.selectedDate() : undefined),
		defaultValue: { stages: [], hr: [], velocity: null },
		loader: async ({ params: date, abortSignal }) => {
			const [stages, hr, velocity] = await Promise.all([
				this.health.getSleepStages(date, abortSignal).catch(() => [] as SleepStage[]),
				this.health.getHeartRateIntraday(date, abortSignal).catch(() => [] as HeartRatePoint[]),
				this.health.getVelocity(date, abortSignal).catch(() => null),
			]);
			return { stages, hr, velocity };
		},
	});

	/** Latches once the first day-load resolves. A day-navigation changes
	 *  the resource's `params`, which Angular reports as `loading` (the
	 *  same status as the very first load) — so status alone can't tell
	 *  "booting" from "navigating". This flag does: the full-screen boot
	 *  spinner shows only while it is false. Set in a constructor effect. */
	private readonly hasLoadedOnce = signal(false);
	/** The last successfully-resolved day payload. On a navigation load the
	 *  resource's `value()` resets to the default (empty), so the view
	 *  reads through this snapshot to keep the previous day's content on
	 *  screen — dimmed by `.stale` — until the new day lands, instead of
	 *  blanking it. Updated in the same constructor effect. */
	private readonly lastDay = signal<DayData>({ stages: [], hr: [], velocity: null });
	/** The day payload to render: the resolved value, or the last good one
	 *  while a new day loads. */
	private readonly displayedDay = computed(() =>
		this.dayData.status() === "resolved" ? this.dayData.value() : this.lastDay(),
	);

	// ─── Derived view state (never set imperatively) ────────────────
	readonly activity = computed(() => this.windowData.value().activity);
	readonly sleep = computed(() => this.windowData.value().sleep);
	readonly sleepStages = computed(() => this.displayedDay().stages);
	readonly intradayHr = computed(() => this.displayedDay().hr);
	readonly velocity = computed(() => this.displayedDay().velocity);
	readonly latestActivity = computed(() => selectDayActivity(this.activity(), this.selectedDate()));
	readonly latestSleep = computed(() => selectDayMainSleep(this.sleep(), this.selectedDate()));

	/** In-body overlay + dim: a day's data is loading (first time or on
	 *  navigation). This is the spinner the user sees while stepping days. */
	readonly dayLoading = computed(() => this.dayData.isLoading());
	/** Full-screen boot spinner: shown only before the dashboard first has
	 *  any data — auth still resolving, or the first day-load hasn't
	 *  returned. Once data has loaded once, navigation uses `dayLoading`
	 *  (the in-body overlay), never this. */
	readonly loading = computed(() => {
		if (!this.authReady()) return true;
		if (!this.authenticated() || !this.fitbitLinked()) return false;
		return !this.hasLoadedOnce() && this.dayData.isLoading();
	});

	/** Most recent PhoneTrack fix — drives the Map tab's live marker.
	 *  Owned here, not in MapComponent, so it survives the Map tab
	 *  being torn down and rebuilt on each visit. */
	readonly liveFix = signal<LatestFix | null>(null);

	constructor() {
		// Seed the live marker from the last cached fix so the Map tab
		// shows a position immediately on load — before the first poll
		// returns — rather than snapping in from the path's end.
		const cached = this.readCachedFix();
		if (cached) this.liveFix.set(cached);

		// Latch first-load and remember the last resolved day. This is what
		// lets the full-screen boot spinner fire only once, and keeps the
		// previous day's content on screen (dimmed) during a navigation
		// reload instead of blanking it. See hasLoadedOnce / lastDay.
		effect(() => {
			if (this.dayData.status() === "resolved") {
				this.lastDay.set(this.dayData.value());
				this.hasLoadedOnce.set(true);
			}
		});

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

		if (ok) {
			// One-shot boot context (UA, viewport, tz, locale) for future
			// bug-correlation. Owner mode only — share-viewer's POST would
			// 403 and the diagnostics are about the OWNER's environment.
			if (!this.isShareView) logBootContext(this.health);

			this.fitbitLinked.set(this.health.user()?.fitbitLinked ?? false);

			if (this.fitbitLinked()) {
				// Restore day + tab from the URL on first paint so reload —
				// and share links like `/share/<token>?tab=map` — open on
				// the right day and tab. Setting these before the data
				// resources first run means a single load for the right day.
				const initial = this.parseDateParam(this.route.snapshot.queryParamMap.get("date"));
				if (initial !== null) this.selectedDate.set(initial);
				const initialTab = this.parseTabParam(this.route.snapshot.queryParamMap.get("tab"));
				if (initialTab !== null) this.view.set(initialTab);

				// Adopt query-param changes the app did not initiate itself:
				// browser back/forward and direct URL edits. Navigation the
				// app triggers updates the signals first, so the equality
				// guards below make this a no-op for those.
				this.querySub = this.route.queryParamMap.subscribe((params) => {
					const tab = this.parseTabParam(params.get("tab"));
					if (tab !== null && tab !== this.view()) this.view.set(tab);
					const next = this.parseDateParam(params.get("date")) ?? todayLocal();
					if (next !== this.selectedDate()) this.selectedDate.set(next);
				});

				// Fire-and-forget: keep PhoneTrack's visualisation filter
				// aligned with "today from 00:00 (or yesterday after
				// midnight before 06:00)". Skip in share mode — the backend
				// 403s, and the recipient has no business touching the
				// owner's PhoneTrack prefs.
				if (!this.isShareView) void this.health.syncPhoneTrackFilter();
			}
		}

		// Data now flows reactively from the resources — no explicit load.
		this.authReady.set(true);
	}

	ngOnDestroy(): void {
		this.querySub?.unsubscribe();
	}

	/** Step the selected day by `delta`. Applies the step to state
	 *  synchronously — so a fast burst of clicks each computes from the
	 *  correct day, not a stale one — then reflects it into `?date=`.
	 *  The `dayData` resource reloads off `selectedDate` and supersedes
	 *  any in-flight load, so only the landed-on day's data is shown. */
	changeDay(delta: number): void {
		const d = new Date(`${this.selectedDate()}T12:00:00`); // noon to avoid DST edge
		d.setDate(d.getDate() + delta);
		const newDate = formatDateInTz(d, browserTimezone());
		if (newDate > this.rightEdge()) return;
		const left = this.leftEdge();
		if (left !== null && newDate < left) return;
		if (newDate === this.selectedDate()) return;
		this.selectedDate.set(newDate);
		// Reflect into the URL (relativeTo keeps `/` or `/share/<token>`
		// and only rewrites the query string). The queryParamMap
		// subscription then sees selectedDate already at newDate and
		// skips a redundant set.
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
		const d = new Date(`${date}T12:00:00`);
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		if (date === formatDateInTz(yesterday, browserTimezone())) return "Yesterday";
		return d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
	}
}
