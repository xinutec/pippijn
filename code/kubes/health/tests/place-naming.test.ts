import { describe, expect, it } from "vitest";
import type { NearbyLandmark } from "../src/geo/osm.js";
import {
	amenityLabelFor,
	type ClusterStat,
	kindPrior,
	mineDwellModel,
	nameCluster,
	nearestVenueKind,
} from "../src/geo/place-naming.js";

function lm(name: string, type: NearbyLandmark["type"], subtype: string, distanceM: number): NearbyLandmark {
	return { name, type, subtype, distanceM };
}

// A user history: quick venues get short visits (~10–15 min), lingering
// venues get long ones (~80–100 min).
const history: ClusterStat[] = [
	{ kind: "quick", totalDwellSec: 600, visitLengthSec: 600 },
	{ kind: "quick", totalDwellSec: 900, visitLengthSec: 900 },
	{ kind: "quick", totalDwellSec: 720, visitLengthSec: 720 },
	{ kind: "linger", totalDwellSec: 5400, visitLengthSec: 5400 },
	{ kind: "linger", totalDwellSec: 9600, visitLengthSec: 4800 },
	{ kind: "linger", totalDwellSec: 6000, visitLengthSec: 6000 },
];
const prior = kindPrior(history);
const dwell = mineDwellModel(history);

const LONG_VISIT = 5400; // a ~90-minute cluster
const SHORT_VISIT = 700; // a ~12-minute cluster

describe("kindPrior", () => {
	it("weights kinds by the user's dwell share", () => {
		expect(prior.get("linger") ?? 0).toBeGreaterThan(prior.get("quick") ?? 0);
	});

	it("smooths an unseen kind to small-but-nonzero, not impossible", () => {
		const clinical = prior.get("clinical") ?? 0;
		expect(clinical).toBeGreaterThan(0);
		expect(clinical).toBeLessThan(prior.get("linger") ?? 0);
	});

	it("falls back to a uniform prior with no history", () => {
		expect(kindPrior([]).get("linger")).toBeCloseTo(0.2, 5);
	});
});

describe("mineDwellModel", () => {
	it("learns that lingering venues have longer visits than quick ones", () => {
		expect(dwell.meanLogByKind.get("quick") ?? 0).toBeLessThan(dwell.meanLogByKind.get("linger") ?? 0);
		expect(dwell.sigmaLog).toBeGreaterThan(0);
		expect(Number.isFinite(dwell.sigmaLog)).toBe(true);
	});

	it("is inert with no history", () => {
		expect(mineDwellModel([]).sigmaLog).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("nameCluster", () => {
	it("a long-dwell cluster rejects a closer quick venue for a café", () => {
		// The bakery is far closer, but a 90-minute visit is implausible
		// for it — the dwell likelihood crushes it.
		const r = nameCluster(
			[lm("A Bakery", "shop", "bakery", 3), lm("A Café", "amenity", "cafe", 14)],
			prior,
			dwell,
			LONG_VISIT,
		);
		expect(r.label).toBe("A Café");
		expect(r.ambiguous).toBe(false);
	});

	it("a short-dwell cluster keeps the closer quick venue", () => {
		// A 12-minute visit fits the bakery and not the café.
		const r = nameCluster(
			[lm("A Bakery", "shop", "bakery", 3), lm("A Café", "amenity", "cafe", 14)],
			prior,
			dwell,
			SHORT_VISIT,
		);
		expect(r.label).toBe("A Bakery");
	});

	it("flags ambiguity when two same-kind venues score close", () => {
		const r = nameCluster(
			[lm("Cafe One", "amenity", "cafe", 12), lm("Cafe Two", "amenity", "cafe", 14)],
			prior,
			dwell,
			LONG_VISIT,
		);
		expect(r.ambiguous).toBe(true);
		expect(r.ranked).toHaveLength(2);
	});

	it("returns a null label when there are no venue candidates", () => {
		const r = nameCluster([lm("A Footpath", "highway", "pedestrian", 5)], prior, dwell, LONG_VISIT);
		expect(r.label).toBeNull();
		expect(r.ranked).toHaveLength(0);
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

describe("amenityLabelFor", () => {
	it("returns the plain name for a confident pick", () => {
		const naming = nameCluster(
			[lm("A Bakery", "shop", "bakery", 3), lm("A Café", "amenity", "cafe", 14)],
			prior,
			dwell,
			LONG_VISIT,
		);
		expect(amenityLabelFor(naming)).toBe("A Café");
	});

	it("hedges 'winner / runner-up' for an ambiguous pick", () => {
		const naming = nameCluster(
			[lm("Cafe One", "amenity", "cafe", 12), lm("Cafe Two", "amenity", "cafe", 14)],
			prior,
			dwell,
			LONG_VISIT,
		);
		expect(amenityLabelFor(naming)).toBe("Cafe One / Cafe Two");
	});

	it("returns null when there is no venue candidate", () => {
		const naming = nameCluster([lm("A Footpath", "highway", "pedestrian", 5)], prior, dwell, LONG_VISIT);
		expect(amenityLabelFor(naming)).toBeNull();
	});
});
