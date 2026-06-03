/**
 * Tests for the presence-continuity emission factor.
 * Phase 3 of `docs/proposals/2026-06-presence-continuity.md`.
 */

import { describe, expect, it } from "vitest";
import { continuityLogLikelihood } from "../src/hmm/factors/presence-continuity.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

const T = 1_700_000_000;

function stat(placeId: number | null): State {
	return { mode: "stationary", placeId, lineName: null, trainEdgeId: null };
}

function obsNoFix(): Observation {
	return {
		ts: T,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 13,
		dayOfWeekLocal: 4,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
	};
}

function obsWithFix(): Observation {
	return { ...obsNoFix(), gps: { lat: 51.5, lon: -0.1, speedKmh: 0 } };
}

describe("continuityLogLikelihood", () => {
	it("returns 0 with no continuity context (factor silent)", () => {
		expect(continuityLogLikelihood(stat(42), obsNoFix(), null)).toBe(0);
	});

	it("returns 0 when priorPlaceId is null", () => {
		const ctx = { priorPlaceId: null, hoursSinceLastConfirmedFix: 0, priorPosterior: 0.95 };
		expect(continuityLogLikelihood(stat(42), obsNoFix(), ctx)).toBe(0);
	});

	it("returns 0 for a state at a different place than the prior", () => {
		const ctx = { priorPlaceId: 42, hoursSinceLastConfirmedFix: 0, priorPosterior: 0.95 };
		expect(continuityLogLikelihood(stat(99), obsNoFix(), ctx)).toBe(0);
	});

	it("returns 0 for non-stationary states", () => {
		const ctx = { priorPlaceId: 42, hoursSinceLastConfirmedFix: 0, priorPosterior: 0.95 };
		const driving: State = { mode: "driving", placeId: null, lineName: null, trainEdgeId: null };
		expect(continuityLogLikelihood(driving, obsNoFix(), ctx)).toBe(0);
	});

	it("returns 0 when the observation has a GPS fix (place-distance handles it)", () => {
		const ctx = { priorPlaceId: 42, hoursSinceLastConfirmedFix: 0, priorPosterior: 0.95 };
		expect(continuityLogLikelihood(stat(42), obsWithFix(), ctx)).toBe(0);
	});

	it("returns a positive log-bonus for a matching state under no-fix evidence", () => {
		const ctx = { priorPlaceId: 42, hoursSinceLastConfirmedFix: 0, priorPosterior: 0.95 };
		const result = continuityLogLikelihood(stat(42), obsNoFix(), ctx);
		expect(result).toBeCloseTo(Math.log(0.5 * 1 * 0.95), 3);
	});

	it("decays with time-since-last-confirmed-fix", () => {
		const fresh = continuityLogLikelihood(stat(42), obsNoFix(), {
			priorPlaceId: 42,
			hoursSinceLastConfirmedFix: 0,
			priorPosterior: 0.95,
		});
		const oneDay = continuityLogLikelihood(stat(42), obsNoFix(), {
			priorPlaceId: 42,
			hoursSinceLastConfirmedFix: 24,
			priorPosterior: 0.95,
		});
		const threeDays = continuityLogLikelihood(stat(42), obsNoFix(), {
			priorPlaceId: 42,
			hoursSinceLastConfirmedFix: 72,
			priorPosterior: 0.95,
		});
		expect(fresh).toBeGreaterThan(oneDay);
		expect(oneDay).toBeGreaterThan(threeDays);
		expect(Math.exp(oneDay - fresh)).toBeCloseTo(Math.exp(-1), 3);
	});

	it("scales with priorPosterior — a 0.5 seed gives less boost than a 0.95 seed", () => {
		const highSeed = continuityLogLikelihood(stat(42), obsNoFix(), {
			priorPlaceId: 42,
			hoursSinceLastConfirmedFix: 0,
			priorPosterior: 0.95,
		});
		const lowSeed = continuityLogLikelihood(stat(42), obsNoFix(), {
			priorPlaceId: 42,
			hoursSinceLastConfirmedFix: 0,
			priorPosterior: 0.5,
		});
		expect(highSeed).toBeGreaterThan(lowSeed);
		expect(Math.exp(highSeed - lowSeed)).toBeCloseTo(0.95 / 0.5, 3);
	});

	it("returns 0 when priorPosterior is 0 (no information to transfer)", () => {
		const ctx = { priorPlaceId: 42, hoursSinceLastConfirmedFix: 0, priorPosterior: 0 };
		expect(continuityLogLikelihood(stat(42), obsNoFix(), ctx)).toBe(0);
	});
});
