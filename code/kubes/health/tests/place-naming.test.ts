import { describe, expect, it } from "vitest";
import type { Stay } from "../src/geo/focus-places.js";
import type { NearbyLandmark } from "../src/geo/osm.js";
import { amenityLabelFor, clusterVisitPattern, nameCluster, type VisitPattern } from "../src/geo/place-naming.js";

function lm(name: string, type: NearbyLandmark["type"], subtype: string, distanceM: number): NearbyLandmark {
	return { name, type, subtype, distanceM };
}

// A long-dwell, mostly-morning, frequently-visited pattern — a café /
// work-spot signature.
const cafePattern: VisitPattern = { visitCount: 12, medianDwellSec: 90 * 60, morningFraction: 0.8 };
// A short midday-stop pattern.
const quickPattern: VisitPattern = { visitCount: 8, medianDwellSec: 12 * 60, morningFraction: 0.3 };

describe("nameCluster", () => {
	it("prefers a café over a closer fast-food for a long-dwell pattern", () => {
		const r = nameCluster(
			[lm("Fried Chicken Co", "amenity", "fast_food", 8), lm("Some Café", "amenity", "cafe", 14)],
			cafePattern,
		);
		expect(r.label).toBe("Some Café");
		expect(r.ambiguous).toBe(false);
	});

	it("a name cue overrides a mis-tag — a fast_food named '...Coffee' reads as a café", () => {
		// Both OSM-tagged fast_food; only the coffee-named one is really
		// a café, and it wins for a long-dwell pattern despite being further.
		const r = nameCluster(
			[lm("Burger Stop", "amenity", "fast_food", 8), lm("Bean Counter Coffee", "amenity", "fast_food", 14)],
			cafePattern,
		);
		expect(r.label).toBe("Bean Counter Coffee");
	});

	it("flags ambiguity when two plausible venues score close", () => {
		const r = nameCluster([lm("Cafe One", "amenity", "cafe", 12), lm("Cafe Two", "amenity", "cafe", 14)], cafePattern);
		expect(r.ambiguous).toBe(true);
		expect(r.ranked).toHaveLength(2);
	});

	it("rejects a clinic for a frequently-visited long-dwell place", () => {
		const r = nameCluster([lm("A Dentist", "amenity", "dentist", 6), lm("A Café", "amenity", "cafe", 20)], cafePattern);
		expect(r.label).toBe("A Café");
	});

	it("prefers fast-food over a café for a short-stop pattern", () => {
		const r = nameCluster(
			[lm("Quick Bite", "amenity", "fast_food", 10), lm("Slow Café", "amenity", "cafe", 10)],
			quickPattern,
		);
		expect(r.label).toBe("Quick Bite");
	});

	it("returns a null label when there are no venue candidates", () => {
		const r = nameCluster([lm("A Footpath", "highway", "pedestrian", 5)], cafePattern);
		expect(r.label).toBeNull();
		expect(r.ranked).toHaveLength(0);
	});
});

describe("clusterVisitPattern", () => {
	function mkStay(startUtc: string, dwellMin: number): Stay {
		const startTs = Math.floor(Date.parse(startUtc) / 1000);
		return {
			startTs,
			endTs: startTs + dwellMin * 60,
			centroidLat: 50.0,
			centroidLon: 5.0,
			pointCount: 6,
			durationSec: dwellMin * 60,
			weight: 1,
		};
	}

	it("summarises visit count, median dwell, and morning fraction", () => {
		// 3 morning starts, 1 afternoon; dwells 60 / 90 / 90 / 120 min.
		const stays: Stay[] = [
			mkStay("2026-02-09T08:00:00Z", 60),
			mkStay("2026-02-10T08:00:00Z", 90),
			mkStay("2026-02-11T08:00:00Z", 90),
			mkStay("2026-02-12T14:00:00Z", 120),
		];
		const p = clusterVisitPattern(stays);
		expect(p.visitCount).toBe(4);
		expect(p.medianDwellSec).toBe(90 * 60);
		expect(p.morningFraction).toBe(0.75);
	});

	it("handles an empty cluster", () => {
		expect(clusterVisitPattern([])).toEqual({ visitCount: 0, medianDwellSec: 0, morningFraction: 0 });
	});
});

describe("amenityLabelFor", () => {
	it("returns the plain name for a confident pick", () => {
		const naming = nameCluster(
			[lm("Fried Chicken Co", "amenity", "fast_food", 8), lm("Some Café", "amenity", "cafe", 14)],
			cafePattern,
		);
		expect(amenityLabelFor(naming)).toBe("Some Café");
	});

	it("hedges 'winner / runner-up' for an ambiguous pick", () => {
		const naming = nameCluster(
			[lm("Cafe One", "amenity", "cafe", 12), lm("Cafe Two", "amenity", "cafe", 14)],
			cafePattern,
		);
		expect(amenityLabelFor(naming)).toBe("Cafe One / Cafe Two");
	});

	it("returns null when there is no venue candidate", () => {
		expect(amenityLabelFor(nameCluster([lm("A Footpath", "highway", "pedestrian", 5)], cafePattern))).toBeNull();
	});
});
