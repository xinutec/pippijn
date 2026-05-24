/**
 * `buildEmissionFn` — per-state emission log-likelihood for the MVP
 * HMM.
 *
 * Tests pin the per-mode preferences:
 *   - High speed favours train/driving over walking.
 *   - Walking-cadence steps favour walking over driving.
 *   - Zero cadence + high HR favours cycling over driving.
 *   - GPS absence with rail tunnel context favours train over walking.
 *   - The unknown mode is a uniform "no preference" fallback.
 */

import { describe, expect, it } from "vitest";
import { buildEmissionFn } from "../src/hmm/emissions.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

function obs(over: Partial<Observation> = {}): Observation {
	return {
		ts: 1_700_000_000,
		gps: { lat: 51.5, lon: -0.1, speedKmh: 0 },
		hr: 70,
		cadence: 0,
		hourLocal: 12,
		dayOfWeekLocal: 3,
		...over,
	};
}

function state(mode: State["mode"], placeId: number | null = null, lineName: string | null = null): State {
	return { mode, placeId, lineName };
}

const emission = buildEmissionFn({});

const HOME_LAT = 51.57;
const HOME_LON = -0.279;
const placeCoords = new Map<number, { lat: number; lon: number }>([[1, { lat: HOME_LAT, lon: HOME_LON }]]);
const emissionWithPlaces = buildEmissionFn({ placeCoords });

describe("buildEmissionFn", () => {
	it("favours train over walking at high speed", () => {
		const fast = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 60 }, cadence: 0 });
		const trainScore = emission(state("train", null, "Metropolitan Line"), fast);
		const walkScore = emission(state("walking"), fast);
		expect(trainScore).toBeGreaterThan(walkScore);
	});

	it("favours walking over driving at walking pace with cadence steps", () => {
		const walking = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 5 }, cadence: 100, hr: 95 });
		const walkScore = emission(state("walking"), walking);
		const driveScore = emission(state("driving"), walking);
		expect(walkScore).toBeGreaterThan(driveScore);
	});

	it("favours cycling over driving at cycling pace with zero cadence and elevated HR", () => {
		const cycling = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 18 }, cadence: 0, hr: 130 });
		const cycleScore = emission(state("cycling"), cycling);
		const driveScore = emission(state("driving"), cycling);
		expect(cycleScore).toBeGreaterThan(driveScore);
	});

	it("favours stationary at near-zero speed", () => {
		const still = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 0 }, cadence: 0, hr: 65 });
		const statScore = emission(state("stationary"), still);
		const walkScore = emission(state("walking"), still);
		expect(statScore).toBeGreaterThan(walkScore);
	});

	it("decides GPS-absent minutes by HR + cadence, not by GPS-presence (which is uniform across modes)", () => {
		// Tunnel-like: GPS absent, restful HR 80, zero cadence.
		// Without uniform GPS-presence, train would win because its
		// p_gps_present was set lower (tunnel-aware). Under the
		// uniform setting (post Phase 1.5 audit), HR + cadence have
		// to discriminate — train's HR mean (75) is closer to 80
		// than walking's HR mean (100), so train still wins, but
		// for the right reason.
		const noFix = obs({ gps: null, hr: 80, cadence: 0 });
		const trainScore = emission(state("train", null, "Metropolitan Line"), noFix);
		const walkScore = emission(state("walking"), noFix);
		expect(trainScore).toBeGreaterThan(walkScore);
	});

	it("unknown is a uniform low-prior fallback (always loses to a positive-evidence state)", () => {
		const walking = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 5 }, cadence: 100, hr: 95 });
		const unknownScore = emission(state("unknown"), walking);
		const walkScore = emission(state("walking"), walking);
		expect(walkScore).toBeGreaterThan(unknownScore);
	});

	it("handles missing biometrics by skipping that factor (not penalising)", () => {
		// Speed strongly suggests walking; HR + cadence missing.
		const partial = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 5 }, hr: null, cadence: null });
		const walkScore = emission(state("walking"), partial);
		const stationaryScore = emission(state("stationary"), partial);
		// Walking still wins on speed alone.
		expect(walkScore).toBeGreaterThan(stationaryScore);
	});

	it("favours stationary@placeId when GPS is close to that place's centroid", () => {
		const atHome = obs({ gps: { lat: HOME_LAT, lon: HOME_LON, speedKmh: 0 }, hr: 65, cadence: 0 });
		const homeScore = emissionWithPlaces(state("stationary", 1), atHome);
		const offNetworkScore = emissionWithPlaces(state("stationary", null), atHome);
		const trainScore = emissionWithPlaces(state("train", null, "Metropolitan Line"), atHome);
		// stationary @ Home should beat stationary @ none AND any movement state.
		expect(homeScore).toBeGreaterThan(offNetworkScore);
		expect(homeScore).toBeGreaterThan(trainScore);
	});

	it("penalises stationary@placeId when GPS is far from that place's centroid", () => {
		const farFromHome = obs({
			gps: { lat: HOME_LAT + 0.05, lon: HOME_LON + 0.05, speedKmh: 0 },
			hr: 65,
			cadence: 0,
		});
		const homeScore = emissionWithPlaces(state("stationary", 1), farFromHome);
		const offNetworkScore = emissionWithPlaces(state("stationary", null), farFromHome);
		// 5km away from home: stationary @ none should beat stationary @ Home.
		expect(offNetworkScore).toBeGreaterThan(homeScore);
	});

	it("does not apply place-distance penalty when GPS is null (overnight at home)", () => {
		const overnightCharging = obs({ gps: null, hr: 60, cadence: null });
		const withPlaceScore = emissionWithPlaces(state("stationary", 1), overnightCharging);
		const withoutPlaceScore = emission(state("stationary", 1), overnightCharging);
		// When GPS is null, both emission functions agree — no place-distance term to apply.
		expect(withPlaceScore).toBe(withoutPlaceScore);
	});

	it("Phase 1.7: placeHourProfiles is ignored at emission (moved to transitions)", () => {
		// Time-of-day boost moved to entry-boost on transitions. The
		// emission shape no longer depends on hour_profile.
		const workProfile = new Array(24).fill(0.04);
		workProfile[14] = 0.1;
		const withProfiles = buildEmissionFn({ placeCoords, placeHourProfiles: new Map([[1, workProfile]]) });
		const withoutProfiles = buildEmissionFn({ placeCoords });
		const at14 = obs({
			ts: 1_700_000_000,
			hourLocal: 14,
			gps: { lat: HOME_LAT, lon: HOME_LON, speedKmh: 0 },
			hr: 80,
			cadence: null,
		});
		expect(withProfiles(state("stationary", 1), at14)).toBe(withoutProfiles(state("stationary", 1), at14));
	});

	it("plane needs very high speed", () => {
		const cruise = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 600 }, cadence: 0, hr: 70 });
		const planeScore = emission(state("plane"), cruise);
		const trainScore = emission(state("train", null, "Metropolitan Line"), cruise);
		expect(planeScore).toBeGreaterThan(trainScore);
	});

	it("never returns NaN or +Infinity", () => {
		const cases: Observation[] = [
			obs({ gps: null, hr: null, cadence: null }),
			obs({ gps: { lat: 0, lon: 0, speedKmh: 0 } }),
			obs({ gps: { lat: 0, lon: 0, speedKmh: 1000 }, hr: 200, cadence: 300 }),
		];
		const states: State[] = [
			state("stationary"),
			state("walking"),
			state("cycling"),
			state("driving"),
			state("train", null, "Metropolitan Line"),
			state("plane"),
			state("unknown"),
		];
		for (const o of cases) {
			for (const s of states) {
				const score = emission(s, o);
				expect(Number.isFinite(score) || score === Number.NEGATIVE_INFINITY).toBe(true);
			}
		}
	});
});
