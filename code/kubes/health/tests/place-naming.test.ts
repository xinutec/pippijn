import { describe, expect, it } from "vitest";
import type { NearbyLandmark } from "../src/geo/osm.js";
import { amenityLabelFor, kindPrior, nameCluster, nearestVenueKind } from "../src/geo/place-naming.js";

function lm(name: string, type: NearbyLandmark["type"], subtype: string, distanceM: number): NearbyLandmark {
	return { name, type, subtype, distanceM };
}

// A user who spends far more time in cafés than fast food.
const cafeUser = kindPrior([
	{ kind: "linger", dwellSec: 100_000 },
	{ kind: "quick", dwellSec: 5_000 },
]);
// The mirror image.
const fastFoodUser = kindPrior([
	{ kind: "linger", dwellSec: 5_000 },
	{ kind: "quick", dwellSec: 100_000 },
]);

describe("kindPrior", () => {
	it("weights kinds by the user's dwell share", () => {
		const p = kindPrior([
			{ kind: "linger", dwellSec: 90 },
			{ kind: "quick", dwellSec: 10 },
		]);
		expect(p.get("linger")).toBeGreaterThan(p.get("quick") ?? 0);
	});

	it("smooths an unseen kind to small-but-nonzero, not impossible", () => {
		const clinical = cafeUser.get("clinical") ?? 0;
		expect(clinical).toBeGreaterThan(0);
		expect(clinical).toBeLessThan(cafeUser.get("linger") ?? 0);
	});

	it("falls back to a uniform prior with no history", () => {
		const p = kindPrior([]);
		expect(p.get("linger")).toBeCloseTo(0.2, 5);
		expect(p.get("clinical")).toBeCloseTo(0.2, 5);
	});
});

describe("nearestVenueKind", () => {
	it("returns the kind of the nearest venue", () => {
		expect(nearestVenueKind([lm("Far Café", "amenity", "cafe", 30), lm("Near Shop", "shop", "convenience", 8)])).toBe(
			"quick",
		);
	});

	it("ignores non-venue features and returns null when there are none", () => {
		expect(nearestVenueKind([lm("A Footpath", "highway", "pedestrian", 3)])).toBeNull();
	});
});

describe("nameCluster", () => {
	it("a café-heavy user gets the café over a closer fast-food", () => {
		const r = nameCluster(
			[lm("A Fast Food", "amenity", "fast_food", 8), lm("A Café", "amenity", "cafe", 14)],
			cafeUser,
		);
		expect(r.label).toBe("A Café");
	});

	it("a fast-food-heavy user gets the fast-food", () => {
		const r = nameCluster(
			[lm("A Fast Food", "amenity", "fast_food", 8), lm("A Café", "amenity", "cafe", 14)],
			fastFoodUser,
		);
		expect(r.label).toBe("A Fast Food");
	});

	it("flags ambiguity when two same-kind venues score close", () => {
		const r = nameCluster([lm("Cafe One", "amenity", "cafe", 12), lm("Cafe Two", "amenity", "cafe", 14)], cafeUser);
		expect(r.ambiguous).toBe(true);
		expect(r.ranked).toHaveLength(2);
	});

	it("returns a null label when there are no venue candidates", () => {
		const r = nameCluster([lm("A Footpath", "highway", "pedestrian", 5)], cafeUser);
		expect(r.label).toBeNull();
		expect(r.ranked).toHaveLength(0);
	});
});

describe("amenityLabelFor", () => {
	it("returns the plain name for a confident pick", () => {
		const naming = nameCluster(
			[lm("A Fast Food", "amenity", "fast_food", 8), lm("A Café", "amenity", "cafe", 14)],
			cafeUser,
		);
		expect(amenityLabelFor(naming)).toBe("A Café");
	});

	it("hedges 'winner / runner-up' for an ambiguous pick", () => {
		const naming = nameCluster(
			[lm("Cafe One", "amenity", "cafe", 12), lm("Cafe Two", "amenity", "cafe", 14)],
			cafeUser,
		);
		expect(amenityLabelFor(naming)).toBe("Cafe One / Cafe Two");
	});

	it("returns null when there is no venue candidate", () => {
		expect(amenityLabelFor(nameCluster([lm("A Footpath", "highway", "pedestrian", 5)], cafeUser))).toBeNull();
	});
});
