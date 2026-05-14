import { Component, OnDestroy, OnInit, inject, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { Subscription } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { MatTabsModule } from "@angular/material/tabs";
import {
	type ActivityDay,
	HealthService,
	type HeartRatePoint,
	type SleepLog,
	type SleepStage,
	type VelocityData,
} from "../../services/health.service";
import { browserTimezone, formatDateInTz, todayLocal } from "../../time-utils";
import { logBootContext } from "../../client-diagnostics";
import { HeartrateChartComponent } from "../heartrate-chart/heartrate-chart.component";
import { HypnogramComponent } from "../hypnogram/hypnogram.component";
import { IntradayHrComponent } from "../intraday-hr/intraday-hr.component";
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
		MatIconModule,
		MatProgressSpinnerModule,
		MatTabsModule,
		SummaryCardsComponent,
		HypnogramComponent,
		IntradayHrComponent,
		SpeedChartComponent,
		TimelineComponent,
		StepsChartComponent,
		HeartrateChartComponent,
		SleepChartComponent,
	],
	templateUrl: "./dashboard.component.html",
	styleUrl: "./dashboard.component.scss",
})
export class DashboardComponent implements OnInit, OnDestroy {
	readonly view = signal<"today" | "trends">("today");
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

	readonly health = inject(HealthService);
	private readonly route = inject(ActivatedRoute);
	private readonly router = inject(Router);
	private querySub: Subscription | null = null;

	/** True iff this dashboard instance is rendering a share URL.
	 *  Set in ngOnInit from the route's `:token` param. */
	private isShareView = false;

	/** Validate a `?date=YYYY-MM-DD` query parameter. Rejects
	 *  malformed strings and future dates (the timeline never
	 *  renders future days). */
	private parseDateParam(raw: string | null): string | null {
		if (raw === null) return null;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
		if (raw > todayLocal()) return null;
		return raw;
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

		// Browser back/forward + in-app navigation: react to query-param
		// changes. The chevron buttons call router.navigate, which fires
		// this subscription, which calls loadData.
		this.querySub = this.route.queryParamMap.subscribe(async (params) => {
			const next = this.parseDateParam(params.get("date")) ?? todayLocal();
			if (next === this.selectedDate()) return;
			this.selectedDate.set(next);
			this.dayLoading.set(true);
			try {
				await this.loadData();
			} finally {
				this.dayLoading.set(false);
			}
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

	async changeDay(delta: number): Promise<void> {
		const d = new Date(this.selectedDate() + "T12:00:00"); // noon to avoid DST edge
		d.setDate(d.getDate() + delta);
		const newDate = formatDateInTz(d, browserTimezone());
		if (newDate > this.rightEdge()) return;
		const left = this.leftEdge();
		if (left !== null && newDate < left) return;
		if (newDate === this.selectedDate()) return;
		// Router navigation with relativeTo: this.route preserves the
		// active path (`/` or `/share/<token>`) and only rewrites the
		// query string. The queryParamMap subscription above picks
		// up the change and calls loadData.
		const queryParams = newDate === todayLocal() ? { date: null } : { date: newDate };
		void this.router.navigate([], {
			relativeTo: this.route,
			queryParams,
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
