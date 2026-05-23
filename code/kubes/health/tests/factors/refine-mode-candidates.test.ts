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
import type { ModeStats } from "../../src/geo/mode-biometrics.js";
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
		const modes = result
			.map((c) => c.mode)
			.filter((m) => m !== "driving" || result.find((c) => c.mode === m && c.wayName));
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
		// 1 train (Tube Line) + 3 from Road A (driving/walking/cycling, all
		// named "Road A") + 0 from unnamed footway (its walking candidate is
		// dropped because Road A already provides a named walking
		// candidate) + 1 fallback = 5.
		expect(result).toHaveLength(5);
		expect(result.some((c) => c.mode === "train" && c.wayName === "Tube Line")).toBe(true);
		expect(result.some((c) => c.mode === "walking" && c.wayName === "Road A")).toBe(true);
		expect(result.some((c) => c.mode === "walking" && c.wayName === undefined)).toBe(false);
	});

	it("drops the unnamed walking candidate when a named walking candidate exists", () => {
		// The OSM-data-duplication case: pavement (footway, no name) and
		// the road it parallels (residential, named). Both produce a
		// walking candidate; only the named one survives so the rendered
		// timeline reads "walking on Barn Rise" rather than empty.
		const ways = [way("highway", "footway", undefined, 1), way("highway", "residential", "Barn Rise", 15)];
		const result = generateRefineModeCandidates("walking", ways);
		const walking = result.filter((c) => c.mode === "walking" && c.wayName);
		const walkingUnnamed = result.filter((c) => c.mode === "walking" && !c.wayName);
		expect(walking).toHaveLength(1);
		expect(walking[0].wayName).toBe("Barn Rise");
		// The fallback (walking with no way info) is the only unnamed walking
		// entry that remains — and it's deliberately the fallback, not a
		// way-attached candidate.
		expect(walkingUnnamed).toHaveLength(1);
		expect(walkingUnnamed[0].wayDistanceM).toBeUndefined();
	});

	it("keeps unnamed walking candidates when no named alternative exists", () => {
		// A footpath through a park with no nearby named road within range:
		// the unnamed footway is the only walking evidence we have, so it
		// stays. Falling back to no label is worse than labelling 'walking
		// on (unnamed footway)' — though the renderer treats this as 'walking'
		// with no label, the candidate is still useful for the factor scorer
		// to score the mode.
		const ways = [way("highway", "footway", undefined, 3)];
		const result = generateRefineModeCandidates("walking", ways);
		const walking = result.filter((c) => c.mode === "walking");
		// One unnamed footway candidate + one unnamed fallback. Both retained.
		expect(walking).toHaveLength(2);
	});

	it("dedup is per-mode: drops unnamed walking when named walking exists, leaves cycling unnamed candidate alone", () => {
		const ways = [
			way("highway", "footway", undefined, 2), // walking-only, unnamed
			way("highway", "residential", "Barn Rise", 12), // walking + driving + cycling, named
			way("highway", "cycleway", undefined, 5), // cycling-only, unnamed
		];
		const result = generateRefineModeCandidates("walking", ways);
		// Walking: footway-unnamed dropped (Barn Rise is named); only Barn Rise survives.
		// Cycling: cycleway-unnamed survives because no named cycling-only
		// alternative exists — but wait, Barn Rise (residential) also emits a
		// cycling candidate which IS named, so the unnamed cycleway is also dropped.
		expect(result.some((c) => c.mode === "walking" && c.wayName === "Barn Rise")).toBe(true);
		expect(result.some((c) => c.mode === "walking" && c.wayName === undefined && c.wayDistanceM !== undefined)).toBe(
			false,
		);
		// Both cycling candidates exist post-dedup IFF the named-cycling test
		// applies to cycling: residential emits a named cycling, cycleway
		// emits unnamed. Unnamed cycling dropped.
		expect(result.some((c) => c.mode === "cycling" && c.wayName === "Barn Rise")).toBe(true);
		expect(result.some((c) => c.mode === "cycling" && c.wayName === undefined && c.waySubtype === "cycleway")).toBe(
			false,
		);
	});

	it("always includes the fallback candidate (originalMode, no way info)", () => {
		const result = generateRefineModeCandidates("walking", [way("highway", "residential", "Some Road", 10)]);
		const fallback = result.find((c) => c.wayDistanceM === undefined);
		expect(fallback).toBeDefined();
		expect(fallback?.mode).toBe("walking");
	});
});

describe("generateRefineModeCandidates — biometric filtering", () => {
	const STATS: ModeStats[] = [
		{
			mode: "walking",
			hrMean: 110,
			hrStd: 12,
			hrSampleCount: 500,
			cadenceMean: 100,
			cadenceStd: 15,
			cadenceSampleCount: 500,
			speedMean: 4.5,
			speedStd: 1,
			speedSampleCount: 500,
			sampleCount: 500,
		},
		{
			mode: "cycling",
			hrMean: 135,
			hrStd: 14,
			hrSampleCount: 200,
			cadenceMean: 5,
			cadenceStd: 3,
			cadenceSampleCount: 200,
			speedMean: 18,
			speedStd: 4,
			speedSampleCount: 200,
			sampleCount: 200,
		},
		{
			mode: "driving",
			hrMean: 75,
			hrStd: 8,
			hrSampleCount: 800,
			cadenceMean: 2,
			cadenceStd: 2,
			cadenceSampleCount: 800,
			speedMean: 35,
			speedStd: 15,
			speedSampleCount: 800,
			sampleCount: 800,
		},
	];

	it("drops cycling candidate when HR is implausibly low for cycling", () => {
		// HR 100 < cycling minPlausible (135 - 2·14 = 107). Cycling candidate vetoed.
		const ways = [way("highway", "residential", "Barn Rise", 15), way("highway", "cycleway", "Some Lane", 5)];
		const result = generateRefineModeCandidates("walking", ways, {
			obs: { hr: 100, cadence: 0, speed: 5 },
			stats: STATS,
		});
		expect(result.some((c) => c.mode === "cycling")).toBe(false);
		// Walking candidate from Barn Rise survives.
		expect(result.some((c) => c.mode === "walking" && c.wayName === "Barn Rise")).toBe(true);
	});

	it("drops cycling candidate when cadence is in walking range at slow speed (phantom-cycling case)", () => {
		const ways = [way("highway", "residential", "Barn Rise", 15)];
		const result = generateRefineModeCandidates("walking", ways, {
			obs: { hr: 140, cadence: 80, speed: 10 },
			stats: STATS,
		});
		expect(result.some((c) => c.mode === "cycling")).toBe(false);
		expect(result.some((c) => c.mode === "walking" && c.wayName === "Barn Rise")).toBe(true);
	});

	it("keeps the fallback candidate even if its mode is biometrically implausible", () => {
		// originalMode=cycling, but biometrics say cycling is impossible.
		// We still keep the fallback so the consumer always has at least
		// one option (the factor scorer picks the next-best surviving
		// candidate; if all way-attached candidates are implausible too,
		// the fallback is the honest 'we don't know what else this could
		// be' answer).
		const ways = [way("highway", "residential", "Barn Rise", 15)];
		const result = generateRefineModeCandidates("cycling", ways, {
			obs: { hr: 100, cadence: 0, speed: 5 },
			stats: STATS,
		});
		const fallback = result.find((c) => c.wayDistanceM === undefined);
		expect(fallback).toBeDefined();
		expect(fallback?.mode).toBe("cycling");
		// But the way-attached cycling candidate IS filtered.
		expect(result.filter((c) => c.mode === "cycling" && c.wayName)).toHaveLength(0);
	});

	it("returns the same result as without biometric ctx when nothing is implausible", () => {
		// Inputs picked so no candidate gets vetoed: HR 110 sits inside
		// the walking band (also above cycling's minPlausible 107),
		// cadence 0 doesn't trip cadence-veto for any low-cadence mode,
		// speed 5 < walking-plausible ceiling.
		const ways = [way("highway", "residential", "Barn Rise", 15)];
		const withoutBiometric = generateRefineModeCandidates("walking", ways);
		const withPlausibleBiometric = generateRefineModeCandidates("walking", ways, {
			obs: { hr: 110, cadence: 0, speed: 5 },
			stats: STATS,
		});
		expect(withoutBiometric).toEqual(withPlausibleBiometric);
	});

	it("filter is a no-op without per-user stats (cold-start user)", () => {
		const ways = [way("highway", "residential", "Barn Rise", 15), way("highway", "cycleway", "Some Lane", 5)];
		const result = generateRefineModeCandidates("walking", ways, {
			obs: { hr: 100, cadence: 0, speed: 5 },
			stats: [],
		});
		// Without stats, no candidate can be vetoed — cycling survives.
		expect(result.some((c) => c.mode === "cycling")).toBe(true);
	});
});
