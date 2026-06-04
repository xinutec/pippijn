/**
 * Phase 6a tests: snapshot-aware OSM helpers behave the same as the
 * DB-backed `nearbyWays` / `nearbyStations` to the precision the
 * equirectangular kernel allows (sub-percent at city-scale).
 *
 * The unit tests use small synthetic snapshots so the math is easy to
 * verify by hand; the byte-equivalence-with-prod check waits until
 * Phase 6d runs golden tests against fixtures.
 */

import { describe, expect, it } from "vitest";
import {
	nearbyStationsInSnapshot,
	nearbyWaysInSnapshot,
	type OsmSnapshot,
	type OsmSnapshotLine,
	type OsmSnapshotPoint,
} from "../src/geo/osm-pure.js";

function line(
	featureType: string,
	subtype: string | null,
	name: string | null,
	geometry: ReadonlyArray<readonly [number, number]>,
): OsmSnapshotLine {
	return { featureType, subtype, name, geometry };
}

function point(
	featureType: string,
	subtype: string | null,
	name: string | null,
	lat: number,
	lon: number,
	tags: Record<string, string> = {},
): OsmSnapshotPoint {
	return { featureType, subtype, name, lat, lon, tags };
}

describe("nearbyWaysInSnapshot", () => {
	it("returns lines within radius, drops lines beyond", () => {
		// Two highways: one runs E-W through (51.50, -0.10), another
		// runs through (51.55, -0.10). Query at (51.50, -0.10, 100).
		const snapshot: OsmSnapshot = {
			lines: [
				line("highway", "residential", "Near Road", [
					[51.5, -0.101],
					[51.5, -0.099],
				]),
				line("highway", "residential", "Far Road", [
					[51.55, -0.101],
					[51.55, -0.099],
				]),
			],
			points: [],
		};
		const result = nearbyWaysInSnapshot(snapshot, 51.5, -0.1, 100);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("Near Road");
		expect(result[0].type).toBe("highway");
		expect(result[0].distanceM).toBeLessThan(10);
	});

	it("returns each feature type separately", () => {
		const snapshot: OsmSnapshot = {
			lines: [
				line("highway", "primary", "Road A", [
					[51.5, -0.1001],
					[51.5, -0.0999],
				]),
				line("railway", "rail", "Line A", [
					[51.5, -0.1001],
					[51.5, -0.0999],
				]),
				line("waterway", "river", "River A", [
					[51.5, -0.1001],
					[51.5, -0.0999],
				]),
				line("aeroway", "runway", "Runway A", [
					[51.5, -0.1001],
					[51.5, -0.0999],
				]),
			],
			points: [],
		};
		const result = nearbyWaysInSnapshot(snapshot, 51.5, -0.1, 50);
		expect(result.map((w) => w.type).sort()).toEqual(["aeroway", "highway", "railway", "waterway"]);
	});

	it("includes aeroway points (airports tagged as nodes)", () => {
		const snapshot: OsmSnapshot = {
			lines: [],
			points: [point("aeroway", "aerodrome", "LHR Terminal", 51.5, -0.1)],
		};
		const result = nearbyWaysInSnapshot(snapshot, 51.5, -0.1, 50);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("LHR Terminal");
	});

	it("ignores feature_types not in the nearbyWays set", () => {
		const snapshot: OsmSnapshot = {
			lines: [
				line("landmark", "park", "Hyde Park edge", [
					[51.5, -0.1001],
					[51.5, -0.0999],
				]),
			],
			points: [],
		};
		const result = nearbyWaysInSnapshot(snapshot, 51.5, -0.1, 100);
		expect(result).toHaveLength(0);
	});

	it("handles empty snapshot", () => {
		expect(nearbyWaysInSnapshot({ lines: [], points: [] }, 51.5, -0.1, 100)).toEqual([]);
	});
});

describe("nearbyStationsInSnapshot", () => {
	it("returns named railway stations within radius", () => {
		const snapshot: OsmSnapshot = {
			lines: [],
			points: [
				point("railway", "station", "King's Cross", 51.531, -0.124, { railway: "station" }),
				point("railway", "station", "Far Station", 51.6, -0.1, { railway: "station" }),
			],
		};
		const result = nearbyStationsInSnapshot(snapshot, 51.531, -0.124, 200);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("King's Cross");
		expect(result[0].subtype).toBe("rail");
	});

	it("derives subway subtype from tags.station=subway", () => {
		const snapshot: OsmSnapshot = {
			lines: [],
			points: [point("railway", "station", "Holborn", 51.5174, -0.12, { station: "subway" })],
		};
		const result = nearbyStationsInSnapshot(snapshot, 51.5174, -0.12, 200);
		expect(result[0].subtype).toBe("subway");
	});

	it("derives tram subtype from tags.tram=yes", () => {
		const snapshot: OsmSnapshot = {
			lines: [],
			points: [point("railway", "tram_stop", "Phipps Bridge", 51.40, -0.18, { tram: "yes" })],
		};
		const result = nearbyStationsInSnapshot(snapshot, 51.40, -0.18, 200);
		expect(result[0].subtype).toBe("tram");
	});

	it("marks entries with subtype subway_entrance", () => {
		const snapshot: OsmSnapshot = {
			lines: [],
			points: [point("railway", "subway_entrance", "Bank A", 51.513, -0.089)],
		};
		const result = nearbyStationsInSnapshot(snapshot, 51.513, -0.089, 200);
		expect(result[0].subtype).toBe("subway_entrance");
	});

	it("collapses duplicate names — station wins over entrance regardless of distance", () => {
		// Both points named "Bank": entrance is closer to query point but
		// the station should still win per dedupeStationsByName's rule.
		const snapshot: OsmSnapshot = {
			lines: [],
			points: [
				point("railway", "subway_entrance", "Bank", 51.5132, -0.0884), // closer
				point("railway", "station", "Bank", 51.5134, -0.0886, { station: "subway" }), // farther
			],
		};
		const result = nearbyStationsInSnapshot(snapshot, 51.5132, -0.0884, 200);
		expect(result).toHaveLength(1);
		expect(result[0].subtype).toBe("subway");
	});

	it("filters out non-station-subtype railway points", () => {
		const snapshot: OsmSnapshot = {
			lines: [],
			points: [point("railway", "signal", "Some Signal", 51.5, -0.1)],
		};
		const result = nearbyStationsInSnapshot(snapshot, 51.5, -0.1, 200);
		expect(result).toEqual([]);
	});

	it("filters by radius", () => {
		const snapshot: OsmSnapshot = {
			lines: [],
			points: [point("railway", "station", "Far One", 51.6, -0.1, { railway: "station" })],
		};
		// ~11 km away, well beyond 200m.
		expect(nearbyStationsInSnapshot(snapshot, 51.5, -0.1, 200)).toEqual([]);
	});

	it("returns empty for empty snapshot", () => {
		expect(nearbyStationsInSnapshot({ lines: [], points: [] }, 51.5, -0.1, 200)).toEqual([]);
	});
});
