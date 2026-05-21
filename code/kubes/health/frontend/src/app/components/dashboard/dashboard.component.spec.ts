import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { provideRouter } from "@angular/router";
import { beforeEach, describe, expect, it } from "vitest";
import { type ActivityDay, HealthService, type SleepLog, type VelocityData } from "../../services/health.service";
import { DashboardComponent } from "./dashboard.component";

// Hand-rolled mock — no spy library needed for these read-only methods.
function makeHealthMock(opts: { activity?: ActivityDay[]; sleep?: SleepLog[] } = {}) {
	return {
		user: signal(null),
		shareToken: signal(null),
		checkAuth: async () => true,
		getActivity: async () => opts.activity ?? [],
		getSleep: async () => opts.sleep ?? [],
		getSleepStages: async () => [],
		getHeartRateIntraday: async () => [],
		getVelocity: async () => ({ points: [], segments: [] }),
	} as unknown as HealthService;
}

function activity(date: string, steps = 5000): ActivityDay {
	return {
		user_id: "test",
		date,
		steps,
		calories_total: 2000,
		calories_active: 500,
		distance_km: 4,
		floors: 5,
		elevation_m: 50,
		minutes_sedentary: 600,
		minutes_lightly_active: 100,
		minutes_fairly_active: 20,
		minutes_very_active: 30,
		active_score: null,
		resting_heart_rate: 60,
		synced_at: new Date().toISOString(),
	} as unknown as ActivityDay;
}

function mainSleep(date: string, minutes = 489): SleepLog {
	return {
		user_id: "test",
		log_id: "1",
		date,
		start_time: `${date}T22:00:00`,
		end_time: `${date}T06:00:00`,
		duration_ms: minutes * 60_000,
		efficiency: 90,
		minutes_asleep: minutes,
		minutes_awake: 10,
		minutes_deep: 90,
		minutes_light: 250,
		minutes_rem: 100,
		minutes_wake: 30,
		is_main_sleep: true,
	} as unknown as SleepLog;
}

describe("DashboardComponent.loadData — date matching", () => {
	beforeEach(() => {
		TestBed.configureTestingModule({
			imports: [DashboardComponent],
			providers: [provideRouter([]), { provide: HealthService, useValue: makeHealthMock() }],
		});
	});

	it("does NOT show yesterday's sleep on today's view when today has no sleep", async () => {
		const today = "2026-05-10";
		const yesterday = "2026-05-09";
		TestBed.overrideProvider(HealthService, {
			useValue: makeHealthMock({
				activity: [activity(yesterday), activity(today, 8000)],
				sleep: [mainSleep(yesterday)], // only yesterday's sleep is synced
			}),
		});
		const fixture = TestBed.createComponent(DashboardComponent);
		const cmp = fixture.componentInstance;
		cmp.selectedDate.set(today);

		await cmp.loadData();

		expect(cmp.latestSleep()).toBeNull(); // ← the regression we fixed earlier
		expect(cmp.latestActivity()?.date).toBe(today);
		expect(cmp.latestActivity()?.steps).toBe(8000);
	});

	it("hides activity card too when today has no activity yet", async () => {
		const today = "2026-05-10";
		const yesterday = "2026-05-09";
		TestBed.overrideProvider(HealthService, {
			useValue: makeHealthMock({
				activity: [activity(yesterday)],
				sleep: [],
			}),
		});
		const fixture = TestBed.createComponent(DashboardComponent);
		const cmp = fixture.componentInstance;
		cmp.selectedDate.set(today);

		await cmp.loadData();

		expect(cmp.latestActivity()).toBeNull();
		expect(cmp.latestSleep()).toBeNull();
	});

	it("shows the matching day's activity and sleep when both are present", async () => {
		const today = "2026-05-10";
		TestBed.overrideProvider(HealthService, {
			useValue: makeHealthMock({
				activity: [activity("2026-05-09"), activity(today, 12345)],
				sleep: [mainSleep("2026-05-09"), mainSleep(today, 480)],
			}),
		});
		const fixture = TestBed.createComponent(DashboardComponent);
		const cmp = fixture.componentInstance;
		cmp.selectedDate.set(today);

		await cmp.loadData();

		expect(cmp.latestActivity()?.steps).toBe(12345);
		expect(cmp.latestSleep()?.minutes_asleep).toBe(480);
		expect(cmp.latestSleep()?.date).toBe(today);
	});

	it("ignores nap sleep records (is_main_sleep=false)", async () => {
		const today = "2026-05-10";
		const nap: SleepLog = { ...mainSleep(today, 30), log_id: "2", is_main_sleep: false } as SleepLog;
		TestBed.overrideProvider(HealthService, {
			useValue: makeHealthMock({
				activity: [],
				sleep: [nap], // only a nap exists for today, no main sleep yet
			}),
		});
		const fixture = TestBed.createComponent(DashboardComponent);
		const cmp = fixture.componentInstance;
		cmp.selectedDate.set(today);

		await cmp.loadData();

		expect(cmp.latestSleep()).toBeNull();
	});
});

/** A promise whose resolution the test triggers by hand — lets a test
 *  interleave the overlapping loadData calls that a fast burst of
 *  day-navigation produces, deterministically. */
interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** HealthService mock whose `getVelocity` is deferred per date: the
 *  test holds each day's promise and resolves it when it chooses, so
 *  load-completion order is fully under the test's control. */
function makeRaceMock(): { health: HealthService; pending: Map<string, Deferred<VelocityData>> } {
	const pending = new Map<string, Deferred<VelocityData>>();
	const health = {
		user: signal(null),
		shareToken: signal(null),
		checkAuth: async () => true,
		getActivity: async () => [],
		getSleep: async () => [],
		getSleepStages: async () => [],
		getHeartRateIntraday: async () => [],
		getVelocity: (date: string) => {
			const d = deferred<VelocityData>();
			pending.set(date, d);
			return d.promise;
		},
	} as unknown as HealthService;
	return { health, pending };
}

describe("DashboardComponent — concurrent day navigation", () => {
	beforeEach(() => {
		TestBed.configureTestingModule({
			imports: [DashboardComponent],
			providers: [
				provideRouter([{ path: "**", children: [] }]),
				{ provide: HealthService, useValue: makeHealthMock() },
			],
		});
	});

	it("drops a day's data when the user navigated away before it loaded", async () => {
		const { health, pending } = makeRaceMock();
		TestBed.overrideProvider(HealthService, { useValue: health });
		const cmp = TestBed.createComponent(DashboardComponent).componentInstance;

		cmp.selectedDate.set("2026-05-14");
		const inFlight = cmp.loadData(); // load starts for 2026-05-14
		cmp.selectedDate.set("2026-05-10"); // user moves on while it is in flight

		const d14 = pending.get("2026-05-14");
		if (!d14) throw new Error("expected a getVelocity call for 2026-05-14");
		d14.resolve({ points: [], segments: [] } as unknown as VelocityData);
		await inFlight;

		// The 2026-05-14 batch came back after the user left that day —
		// it must not overwrite the current day's state.
		expect(cmp.velocity()).toBeNull();
	});

	it("keeps the landed-on day's data when an earlier day's load resolves last", async () => {
		const { health, pending } = makeRaceMock();
		TestBed.overrideProvider(HealthService, { useValue: health });
		const cmp = TestBed.createComponent(DashboardComponent).componentInstance;

		cmp.selectedDate.set("2026-05-14");
		const loadLeaving = cmp.loadData(); // the day being left
		cmp.selectedDate.set("2026-05-10");
		const loadLanded = cmp.loadData(); // the day the user landed on

		const velLeaving = { points: [], segments: [] } as unknown as VelocityData;
		const velLanded = { points: [], segments: [] } as unknown as VelocityData;
		const dLeaving = pending.get("2026-05-14");
		const dLanded = pending.get("2026-05-10");
		if (!dLeaving || !dLanded) throw new Error("expected getVelocity calls for both days");
		// Out of order: the landed-on day returns first, the older day's
		// slower request returns last.
		dLanded.resolve(velLanded);
		dLeaving.resolve(velLeaving);
		await Promise.all([loadLeaving, loadLanded]);

		expect(cmp.velocity()).toBe(velLanded);
	});

	it("steps one day per changeDay call in a fast burst", () => {
		const { health } = makeRaceMock();
		TestBed.overrideProvider(HealthService, { useValue: health });
		const cmp = TestBed.createComponent(DashboardComponent).componentInstance;

		cmp.selectedDate.set("2026-05-14");
		// Four clicks with no chance for a router round-trip in between.
		cmp.changeDay(-1);
		cmp.changeDay(-1);
		cmp.changeDay(-1);
		cmp.changeDay(-1);

		expect(cmp.selectedDate()).toBe("2026-05-10");
	});
});
