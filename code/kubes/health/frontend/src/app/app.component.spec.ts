import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { describe, expect, it, beforeEach } from "vitest";
import { AppComponent } from "./app.component";
import { HealthService, type ActivityDay, type SleepLog } from "./services/health.service";

// Hand-rolled mock — no spy library needed for these read-only methods.
function makeHealthMock(opts: { activity?: ActivityDay[]; sleep?: SleepLog[] } = {}) {
	return {
		user: signal(null),
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
		log_id: 1,
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

describe("AppComponent.loadData — date matching", () => {
	beforeEach(() => {
		TestBed.configureTestingModule({
			imports: [AppComponent],
			providers: [{ provide: HealthService, useValue: makeHealthMock() }],
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
		const fixture = TestBed.createComponent(AppComponent);
		const cmp = fixture.componentInstance;
		cmp.selectedDate.set(today);

		await cmp.loadData();

		expect(cmp.latestSleep()).toBeNull(); // ← the regression we just fixed
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
		const fixture = TestBed.createComponent(AppComponent);
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
		const fixture = TestBed.createComponent(AppComponent);
		const cmp = fixture.componentInstance;
		cmp.selectedDate.set(today);

		await cmp.loadData();

		expect(cmp.latestActivity()?.steps).toBe(12345);
		expect(cmp.latestSleep()?.minutes_asleep).toBe(480);
		expect(cmp.latestSleep()?.date).toBe(today);
	});

	it("ignores nap sleep records (is_main_sleep=false)", async () => {
		const today = "2026-05-10";
		const nap: SleepLog = { ...mainSleep(today, 30), log_id: 2, is_main_sleep: false } as SleepLog;
		TestBed.overrideProvider(HealthService, {
			useValue: makeHealthMock({
				activity: [],
				sleep: [nap], // only a nap exists for today, no main sleep yet
			}),
		});
		const fixture = TestBed.createComponent(AppComponent);
		const cmp = fixture.componentInstance;
		cmp.selectedDate.set(today);

		await cmp.loadData();

		expect(cmp.latestSleep()).toBeNull();
	});
});
