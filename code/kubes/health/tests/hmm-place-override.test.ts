import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/velocity.js";
import type { HmmSegment } from "../src/hmm/persist.js";
import { applyHsmmPlaceOverride } from "../src/hmm/place-override.js";

/**
 * `applyHsmmPlaceOverride` is the integration glue between the
 * HSMM's place picks (from `decoded_days`) and the heuristic
 * pipeline's segments. For each pipeline stationary segment, it
 * finds the dominant HSMM placeId across the segment's minutes and
 * overrides the segment's `place` display name when the HSMM is
 * confident.
 *
 * Pure function — tested with synthetic segments + name lookup
 * tables, no DB or live data.
 */

const MIN = 60;
const TS = 1_716_000_000;

function stationary(startMin: number, endMin: number, place: string | null): EnrichedSegment {
	return {
		startTs: TS + startMin * MIN,
		endTs: TS + endMin * MIN,
		mode: "stationary",
		pointCount: 0,
		distM: 0,
		avgSpeed: 0,
		maxSpeed: 0,
		avgKmh: 0,
		maxKmh: 0,
		confidence: 1,
		confidenceMargin: 0,
		linearity: 0,
		place: place ?? undefined,
	} as unknown as EnrichedSegment;
}

function moving(startMin: number, endMin: number, mode: string): EnrichedSegment {
	return {
		startTs: TS + startMin * MIN,
		endTs: TS + endMin * MIN,
		mode,
		pointCount: 0,
		distM: 0,
		avgSpeed: 5,
		maxSpeed: 5,
		avgKmh: 5,
		maxKmh: 5,
		confidence: 1,
		confidenceMargin: 0,
		linearity: 0,
	} as unknown as EnrichedSegment;
}

function hsmm(startMin: number, endMin: number, mode: HmmSegment["mode"], placeId: number | null = null): HmmSegment {
	return {
		startTs: TS + startMin * MIN,
		endTs: TS + endMin * MIN,
		mode,
		placeId,
		lineName: null,
	};
}

const PLACES = new Map<number, { displayName: string | null }>([
	[1, { displayName: "Home" }],
	[2, { displayName: "Cleveland Clinic London" }],
	[3, { displayName: null }], // place with no display name (just an id)
]);

describe("applyHsmmPlaceOverride", () => {
	it("returns segments unchanged when no HSMM segments overlap", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm: HmmSegment[] = [];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out).toEqual(segments);
	});

	it("overrides a stationary segment's place when HSMM dominant is a different known place", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 2)]; // Cleveland Clinic
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Cleveland Clinic London");
	});

	it("leaves a stationary segment alone when HSMM agrees", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 1)]; // Home
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Home");
	});

	it("does not override when HSMM dominant placeId is null (off-network)", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", null)];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		// Pipeline picked Home; HSMM was uncertain about place. Trust pipeline.
		expect(out[0].place).toBe("Home");
	});

	it("does not override when HSMM thinks the segment is NOT stationary", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "walking")];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Home");
	});

	it("only overrides stationary segments — walking is untouched", () => {
		const segments = [moving(0, 60, "walking")];
		const hmm = [hsmm(0, 60, "stationary", 2)];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].mode).toBe("walking");
		expect(out[0].place).toBeUndefined();
	});

	it("picks the HSMM placeId with majority overlap minutes", () => {
		const segments = [stationary(0, 60, "Home")];
		// HSMM split: 20 min Cleveland Clinic, 40 min Home → Home wins.
		const hmm = [hsmm(0, 20, "stationary", 2), hsmm(20, 60, "stationary", 1)];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Home");
	});

	it("skips override when the dominant placeId has no display_name", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 3)]; // place #3 has display_name=null
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		// Can't surface "#3" as a human label — keep pipeline's.
		expect(out[0].place).toBe("Home");
	});

	it("handles multiple stationary segments independently", () => {
		const segments = [stationary(0, 60, "Home"), moving(60, 90, "walking"), stationary(90, 180, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 1), hsmm(60, 90, "walking"), hsmm(90, 180, "stationary", 2)];
		const out = applyHsmmPlaceOverride(segments, hmm, PLACES);
		expect(out[0].place).toBe("Home");
		expect(out[2].place).toBe("Cleveland Clinic London");
	});

	it("does not mutate input arrays or segment objects", () => {
		const segments = [stationary(0, 60, "Home")];
		const hmm = [hsmm(0, 60, "stationary", 2)];
		const originalPlace = segments[0].place;
		applyHsmmPlaceOverride(segments, hmm, PLACES);
		// Input is unchanged after the call.
		expect(segments[0].place).toBe(originalPlace);
	});
});
