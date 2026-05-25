import { describe, expect, it } from "vitest";
import { buildEntryPrior } from "../src/hmm/entry-prior.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

/**
 * `buildEntryPrior` produces the per-segment-entry log-prior the
 * HSMM Viterbi applies at t=0 and at every new-segment start. Today
 * it carries the hour-of-day arrival rate; future entry priors
 * compose into the same callback.
 *
 * Critical invariant: the boost fires ONCE per segment, not per
 * minute. Composition correctness lives in the HSMM Viterbi tests;
 * this file checks the math of the prior in isolation.
 */

function obs(over: Partial<Observation> = {}): Observation {
	return {
		ts: 1_700_000_000,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 12,
		dayOfWeekLocal: 1,
		inBed: false,
		...over,
	};
}

function stationary(placeId: number | null): State {
	return { mode: "stationary", placeId, lineName: null };
}

describe("buildEntryPrior", () => {
	it("returns 0 when no profiles are supplied", () => {
		const fn = buildEntryPrior({});
		expect(fn(stationary(1), obs())).toBe(0);
	});

	it("boosts stationary @ knownPlace by log(24 × profile[h])", () => {
		const profile = new Array(24).fill(0.04);
		profile[14] = 0.1;
		profile[4] = 0.01;
		const fn = buildEntryPrior({ placeHourProfiles: new Map([[1, profile]]) });
		const at14 = fn(stationary(1), obs({ hourLocal: 14 }));
		const at04 = fn(stationary(1), obs({ hourLocal: 4 }));
		// 14:00 boost log(2.4); 04:00 boost log(0.24). Delta ≈ 2.30.
		expect(at14 - at04).toBeCloseTo(Math.log(24 * 0.1) - Math.log(24 * 0.01), 2);
	});

	it("floors zero hour_profile entries — no hard zero", () => {
		const profile = new Array(24).fill(0.043);
		profile[7] = 0;
		const fn = buildEntryPrior({ placeHourProfiles: new Map([[1, profile]]) });
		const v = fn(stationary(1), obs({ hourLocal: 7 }));
		expect(Number.isFinite(v)).toBe(true);
		// Floor at 0.001 → log(0.024) ≈ -3.73.
		expect(v).toBeCloseTo(Math.log(24 * 0.001), 2);
	});

	it("returns 0 for movement modes and off-network stationary", () => {
		const profile = new Array(24).fill(0).map((_, i) => (i === 14 ? 0.5 : 0.022));
		const fn = buildEntryPrior({ placeHourProfiles: new Map([[1, profile]]) });
		const at14 = obs({ hourLocal: 14 });
		// Movement: no boost regardless of profile.
		expect(fn({ mode: "walking", placeId: null, lineName: null }, at14)).toBe(0);
		expect(fn({ mode: "train", placeId: null, lineName: null }, at14)).toBe(0);
		// Off-network stationary: no boost (no place to look up).
		expect(fn(stationary(null), at14)).toBe(0);
		// stationary@knownPlace WITH a profile: positive boost.
		expect(fn(stationary(1), at14)).toBeGreaterThan(0);
	});

	it("returns 0 for placeIds with no profile entry in the map", () => {
		const profile = new Array(24).fill(1 / 24);
		const fn = buildEntryPrior({ placeHourProfiles: new Map([[1, profile]]) });
		// Place 99 has no profile — no boost.
		expect(fn(stationary(99), obs())).toBe(0);
	});

	it("returns 0 for malformed profile arrays (length != 24)", () => {
		const shortProfile = [0.5, 0.5];
		const fn = buildEntryPrior({ placeHourProfiles: new Map([[1, shortProfile]]) });
		expect(fn(stationary(1), obs())).toBe(0);
	});
});
