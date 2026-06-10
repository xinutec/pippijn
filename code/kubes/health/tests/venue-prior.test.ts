/**
 * Venue-plausibility scoring (task #246).
 *
 * Replaces pickBestLandmark's `type priority − distance/40m` with summed
 * weighted log-evidence per candidate, mirroring the mode factor scorer:
 *
 *   - distance likelihood (−log(d/25), clamped)
 *   - venue-over-area offset (a real venue beats a park/square/way at
 *     comparable distance, but not across a large distance gap)
 *   - visit-shape prior: P(type) × P(dwell bucket | type) × P(hour | type),
 *     MINED from the user's own stay history (never hand-tuned numbers) with
 *     subtype → category → uniform backoff
 *   - opening-hours evidence (open fraction during the stay; absence of the
 *     tag is NO evidence, weighted so stale OSM hours can be out-voted)
 *   - never-a-destination subtypes (street furniture: post boxes, vending
 *     machines, benches) are excluded outright — the one binary rule, kept
 *     to objects that have no premises to be "at"
 *
 * The motivating day: a 74-minute 19:00 sit must resolve to the restaurant
 * at 32 m, not the (closed, errand-shaped) pharmacy at 18 m; and when no
 * venue is plausible the area label must win — honest beats least-wrong.
 *
 * All venues, coordinates and histories below are synthetic.
 */

import { describe, expect, it } from "vitest";
import type { NearbyLandmark } from "../src/geo/osm.js";
import {
	NEVER_DESTINATION_SUBTYPES,
	type VenuePriors,
	categoryOfSubtype,
	dwellBucket,
	rankVenues,
} from "../src/geo/venue-prior.js";

// --- helpers -------------------------------------------------------------

function venue(name: string, subtype: string, distanceM: number, openingHours?: string): NearbyLandmark {
	const type = subtype === "hotel" ? "tourism" : subtype === "clothes" ? "shop" : "amenity";
	return { name, type, subtype, distanceM, openingHours };
}

function area(name: string, distanceM: number): NearbyLandmark {
	return { name, type: "leisure", subtype: "park", distanceM };
}

/** Build per-type stats: visits spread over one dwell bucket + hour range. */
function stats(visits: number, bucket: number, hourFrom: number, hourTo: number) {
	const dwell = [0, 0, 0, 0];
	dwell[bucket] = visits;
	const hours = new Array(24).fill(0);
	const span = hourTo - hourFrom;
	for (let h = hourFrom; h < hourTo; h++) hours[h] = visits / span;
	return { visits, dwell, hours };
}

/** A synthetic history: lots of meal-length food visits (midday + evening),
 *  a few short daytime errands. */
function foodHeavyPriors(): VenuePriors {
	return {
		bySubtype: {
			restaurant: stats(40, 2, 12, 22),
			cafe: stats(20, 1, 9, 17),
			pharmacy: stats(3, 0, 10, 17),
		},
		byCategory: {
			food: stats(60, 2, 9, 22),
			errand: stats(5, 0, 9, 18),
		},
		totalVisits: 65,
	};
}

// Tuesday 2026-06-09, Europe/London (BST = UTC+1): 19:03–20:17 local.
const DINNER = {
	startUnix: Date.UTC(2026, 5, 9, 18, 3) / 1000,
	endUnix: Date.UTC(2026, 5, 9, 19, 17) / 1000,
	tz: "Europe/London",
};

// --- structure -----------------------------------------------------------

describe("categoryOfSubtype", () => {
	it("maps common subtypes to their dwell-shape pools", () => {
		expect(categoryOfSubtype("restaurant")).toBe("food");
		expect(categoryOfSubtype("pub")).toBe("food");
		expect(categoryOfSubtype("hotel")).toBe("lodging");
		expect(categoryOfSubtype("pharmacy")).toBe("errand");
		expect(categoryOfSubtype("hairdresser")).toBe("errand");
		expect(categoryOfSubtype("hospital")).toBe("institution");
		expect(categoryOfSubtype("cinema")).toBe("leisure");
	});

	it("maps unknown subtypes to other", () => {
		expect(categoryOfSubtype("hackerspace_zoo")).toBe("other");
	});
});

describe("dwellBucket", () => {
	it("buckets errand / short / meal / long dwells", () => {
		expect(dwellBucket(5 * 60)).toBe(0);
		expect(dwellBucket(25 * 60)).toBe(1);
		expect(dwellBucket(74 * 60)).toBe(2);
		expect(dwellBucket(5 * 3600)).toBe(3);
	});
});

// --- ranking, context-free (parity with the old picker's pinned behavior) -

describe("rankVenues without stay context", () => {
	it("prefers a venue over an area at the same distance", () => {
		const r = rankVenues([area("Town Square", 50), venue("Trattoria", "restaurant", 50)], null, null);
		expect(r[0].landmark.name).toBe("Trattoria");
	});

	it("prefers the closer venue among equals", () => {
		const r = rankVenues([venue("Far Cafe", "cafe", 90), venue("Near Trattoria", "restaurant", 20)], null, null);
		expect(r[0].landmark.name).toBe("Near Trattoria");
	});

	it("does not let a far venue beat the park the stay sits in", () => {
		const r = rankVenues([venue("Distant Cafe", "cafe", 95), area("Adjacent Park", 5)], null, null);
		expect(r[0].landmark.name).toBe("Adjacent Park");
	});

	it("still prefers a venue only slightly farther than the park", () => {
		const r = rankVenues([venue("Corner Cafe", "cafe", 30), area("Small Park", 10)], null, null);
		expect(r[0].landmark.name).toBe("Corner Cafe");
	});

	it("puts shop and amenity venues on equal footing (distance decides)", () => {
		// #173: the old type table ranked shop below amenity categorically.
		const r = rankVenues([venue("Bookshop", "clothes", 12), venue("Cafe", "cafe", 35)], null, null);
		expect(r[0].landmark.name).toBe("Bookshop");
	});

	it("an enclosing institution outranks everything", () => {
		const hospital: NearbyLandmark = {
			name: "City Hospital",
			type: "amenity",
			subtype: "hospital",
			distanceM: 55,
			enclosing: true,
		};
		const r = rankVenues([venue("Corner Cafe", "cafe", 8), hospital], null, null);
		expect(r[0].landmark.name).toBe("City Hospital");
	});
});

// --- never-a-destination -------------------------------------------------

describe("never-a-destination filter", () => {
	it("contains only premises-less street furniture", () => {
		expect(NEVER_DESTINATION_SUBTYPES.has("post_box")).toBe(true);
		expect(NEVER_DESTINATION_SUBTYPES.has("vending_machine")).toBe(true);
		// Things with premises (however unlikely as a long stay) stay
		// weighted, not filtered: weight, don't filter.
		expect(NEVER_DESTINATION_SUBTYPES.has("charging_station")).toBe(false);
		expect(NEVER_DESTINATION_SUBTYPES.has("parking")).toBe(false);
	});

	it("never labels a stay with a post box, however close", () => {
		const postBox: NearbyLandmark = { name: "SW1 123", type: "amenity", subtype: "post_box", distanceM: 3 };
		const r = rankVenues([postBox, venue("Trattoria", "restaurant", 40)], null, null);
		expect(r[0].landmark.name).toBe("Trattoria");
		expect(r.some((c) => c.landmark.subtype === "post_box")).toBe(false);
	});

	it("falls back to the unfiltered list when everything is street furniture", () => {
		const postBox: NearbyLandmark = { name: "SW1 123", type: "amenity", subtype: "post_box", distanceM: 3 };
		const r = rankVenues([postBox], null, null);
		expect(r).toHaveLength(1);
	});
});

// --- mined visit-shape prior ----------------------------------------------

describe("rankVenues with stay shape + mined priors", () => {
	it("resolves a meal-length evening sit to the restaurant, not the closer errand venue", () => {
		const r = rankVenues(
			[venue("Corner Pharmacy", "pharmacy", 18), venue("Trattoria", "restaurant", 32)],
			DINNER,
			foodHeavyPriors(),
		);
		expect(r[0].landmark.name).toBe("Trattoria");
	});

	it("without priors the same pair falls back to distance (pharmacy wins)", () => {
		const r = rankVenues([venue("Corner Pharmacy", "pharmacy", 18), venue("Trattoria", "restaurant", 32)], DINNER, null);
		expect(r[0].landmark.name).toBe("Corner Pharmacy");
	});

	it("backs off through category for an unmined subtype", () => {
		// "bistro" has no per-subtype history, but its category (food) is
		// well represented — it must still beat the errand venue for a
		// dinner-shaped sit.
		const priors = foodHeavyPriors();
		const r = rankVenues([venue("Corner Pharmacy", "pharmacy", 18), venue("Chez Synth", "bistro", 32)], DINNER, priors);
		expect(r[0].landmark.name).toBe("Chez Synth");
	});

	it("does not let the prior overrule a decisive distance gap", () => {
		// The restaurant prior is strong, but 250 m vs 8 m is not a
		// labelling ambiguity — the user is at the pharmacy's building.
		const r = rankVenues(
			[venue("Corner Pharmacy", "pharmacy", 8), venue("Trattoria", "restaurant", 250)],
			DINNER,
			foodHeavyPriors(),
		);
		expect(r[0].landmark.name).toBe("Corner Pharmacy");
	});

	it("handles empty priors without NaN", () => {
		const empty: VenuePriors = { bySubtype: {}, byCategory: {}, totalVisits: 0 };
		const r = rankVenues([venue("Trattoria", "restaurant", 32)], DINNER, empty);
		expect(Number.isFinite(r[0].total)).toBe(true);
	});
});

// --- opening-hours evidence -----------------------------------------------

describe("rankVenues with opening hours", () => {
	it("prefers the open restaurant over a closer closed one", () => {
		const r = rankVenues(
			[
				venue("Closed Bistro", "restaurant", 15, "Mo-Fr 09:00-17:00"),
				venue("Open Trattoria", "restaurant", 35, "Mo-Su 12:00-23:00"),
			],
			DINNER,
			null,
		);
		expect(r[0].landmark.name).toBe("Open Trattoria");
	});

	it("treats an unparseable or missing tag as no evidence", () => {
		const r = rankVenues(
			[venue("Sunrise Cafe", "cafe", 20, "sunrise-sunset"), venue("Untagged Cafe", "cafe", 20)],
			DINNER,
			null,
		);
		// Neither candidate gains or loses: ordering falls to the stable
		// tie-break, and both totals are equal.
		expect(r[0].total).toBeCloseTo(r[1].total, 6);
	});

	it("being open is weak evidence, being closed is strong", () => {
		const open = rankVenues([venue("Open", "cafe", 20, "Mo-Su 00:00-24:00")], DINNER, null)[0];
		const closed = rankVenues([venue("Closed", "cafe", 20, "Mo-Fr 02:00-03:00")], DINNER, null)[0];
		const neutral = rankVenues([venue("Untagged", "cafe", 20)], DINNER, null)[0];
		expect(open.total - neutral.total).toBeGreaterThan(0);
		expect(open.total - neutral.total).toBeLessThan(1);
		expect(neutral.total - closed.total).toBeGreaterThan(1.5);
	});

	it("lets the area label win when every venue is implausible", () => {
		// Honest fallback: one distant closed venue vs the square the stay
		// is on — the square must win rather than the least-wrong venue.
		const r = rankVenues(
			[venue("Closed Bistro", "restaurant", 80, "Mo-Fr 09:00-17:00"), area("Station Square", 12)],
			DINNER,
			null,
		);
		expect(r[0].landmark.name).toBe("Station Square");
	});
});
