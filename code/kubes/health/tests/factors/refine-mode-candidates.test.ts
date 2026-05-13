/**
 * Tests for `generateRefineModeCandidates` — the minimal Phase 1
 * candidate generator that turns a `NearbyWay[]` + `originalMode`
 * into a list of `ModeCandidate` for the aggregator.
 *
 * Design notes (per
 * `docs/proposals/2026-05-scored-classification.md` Phase 1):
 *
 * - One candidate per (way, plausibly-compatible-mode) pair. Driveable
 *   highways admit driving/walking/cycling; pedestrian-only highways
 *   admit walking; cycleway admits cycling; railway admits train;
 *   aeroway runway/taxiway admits plane; aeroway terminal/aerodrome
 *   admits stationary.
 * - Plus a fallback candidate carrying the segment classifier's
 *   `originalMode` with no way info, so the consumer never receives
 *   zero candidates (and so segments where no useful way is in
 *   range still produce some output).
 * - The generator does NOT pick — that's the factors' job. The
 *   generator is dumb about speed/context; it just enumerates the
 *   plausible labelling space.
 */

import { describe, expect, it } from "vitest";
import { generateRefineModeCandidates } from "../../src/geo/factors/refine-mode-candidates.js";
import type { NearbyWay } from "../../src/geo/osm.js";

const way = (type: string, subtype: string, name?: string, distanceM?: number): NearbyWay => ({
	type,
	subtype,
	name,
	distanceM,
});

describe("generateRefineModeCandidates", () => {
	it("emits driving/walking/cycling candidates for a driveable highway", () => {
		const result = generateRefineModeCandidates("driving", [way("highway", "primary", "A1", 25)]);
		const modes = result.map((c) => c.mode).filter((m) => m !== "driving" || result.find((c) => c.mode === m && c.wayName));
		// driving-on-A1, walking-on-A1, cycling-on-A1, and an originalMode fallback
		expect(result.some((c) => c.mode === "driving" && c.wayName === "A1")).toBe(true);
		expect(result.some((c) => c.mode === "walking" && c.wayName === "A1")).toBe(true);
		expect(result.some((c) => c.mode === "cycling" && c.wayName === "A1")).toBe(true);
		expect(modes.length).toBeGreaterThanOrEqual(3);
	});

	it("emits a walking-only candidate for a pedestrian highway", () => {
		const result = generateRefineModeCandidates("driving", [way("highway", "footway", undefined, 12)]);
		const wayCands = result.filter((c) => c.waySubtype === "footway");
		expect(wayCands).toHaveLength(1);
		expect(wayCands[0].mode).toBe("walking");
	});

	it("emits a cycling-only candidate for a cycleway", () => {
		const result = generateRefineModeCandidates("walking", [way("highway", "cycleway", undefined, 15)]);
		const wayCands = result.filter((c) => c.waySubtype === "cycleway");
		expect(wayCands).toHaveLength(1);
		expect(wayCands[0].mode).toBe("cycling");
	});

	it("emits a train candidate for a railway way", () => {
		const result = generateRefineModeCandidates("driving", [way("railway", "subway", "Jubilee Line", 18)]);
		expect(result.some((c) => c.mode === "train" && c.wayName === "Jubilee Line" && c.wayDistanceM === 18)).toBe(true);
	});

	it("emits a plane candidate for an aeroway runway or taxiway", () => {
		expect(generateRefineModeCandidates("driving", [way("aeroway", "runway")]).some((c) => c.mode === "plane")).toBe(
			true,
		);
		expect(generateRefineModeCandidates("driving", [way("aeroway", "taxiway")]).some((c) => c.mode === "plane")).toBe(
			true,
		);
	});

	it("emits a stationary candidate for an aeroway aerodrome/terminal", () => {
		expect(
			generateRefineModeCandidates("driving", [way("aeroway", "aerodrome")]).some((c) => c.mode === "stationary"),
		).toBe(true);
		expect(
			generateRefineModeCandidates("driving", [way("aeroway", "terminal")]).some((c) => c.mode === "stationary"),
		).toBe(true);
	});

	it("always includes an originalMode fallback candidate (no way info)", () => {
		const result = generateRefineModeCandidates("driving", [way("railway", "subway", "X")]);
		const fallback = result.find((c) => c.mode === "driving" && !c.wayName);
		expect(fallback).toBeDefined();
	});

	it("propagates wayDistanceM and waySubtype onto candidate", () => {
		const result = generateRefineModeCandidates("driving", [way("highway", "secondary", "Y St", 35)]);
		const drivingCand = result.find((c) => c.mode === "driving" && c.wayName === "Y St");
		expect(drivingCand?.wayDistanceM).toBe(35);
		expect(drivingCand?.waySubtype).toBe("secondary");
	});

	it("returns the fallback alone when no ways are provided", () => {
		const result = generateRefineModeCandidates("walking", []);
		expect(result).toHaveLength(1);
		expect(result[0].mode).toBe("walking");
		expect(result[0].wayName).toBeUndefined();
	});

	it("skips unknown way types (no candidate added)", () => {
		const result = generateRefineModeCandidates("driving", [way("waterway", "river", "Thames", 50)]);
		// Only the fallback should be present
		expect(result).toHaveLength(1);
		expect(result[0].mode).toBe("driving");
	});

	it("aggregates candidates from multiple ways", () => {
		const ways = [
			way("railway", "subway", "Tube Line", 20),
			way("highway", "primary", "Road A", 30),
			way("highway", "footway", undefined, 12),
		];
		const result = generateRefineModeCandidates("driving", ways);
		// 1 train (rail) + 3 (driving/walking/cycling on Road A) + 1 walking (footway) + 1 fallback = 6
		expect(result.length).toBeGreaterThanOrEqual(6);
	});
});
