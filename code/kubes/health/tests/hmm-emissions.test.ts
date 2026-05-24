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

	it("treats GPS-absent minutes as evidence for train (when the prior says train has high p_gps_absent)", () => {
		const noFix = obs({ gps: null, hr: 80, cadence: 0 });
		const trainScore = emission(state("train", null, "Metropolitan Line"), noFix);
		const walkScore = emission(state("walking"), noFix);
		// In a tunnel: GPS absent + low cadence + moderate HR → train more likely than walking.
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
