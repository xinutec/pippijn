import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine } from "../src/geo/route-graph.js";
import { buildLineProximityFactor } from "../src/hmm/line-proximity-factor.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

/**
 * `buildLineProximityFactor` complements `route-rail-evidence`:
 * route-rail-evidence fires only at GPS-NULL minutes (gap bookended
 * by underground L). This factor fires at GPS-PRESENT minutes,
 * scoring train @ L by whether L's actual track geometry passes
 * near the observed GPS fix.
 *
 * The two are disjoint by design: at a GPS-present minute the
 * route-rail-evidence returns 0; at a GPS-null minute this factor
 * returns 0.
 */

function line(over: Partial<RawOsmLine>): RawOsmLine {
	return {
		osm_id: 1n,
		osm_type: "way",
		feature_type: "railway",
		subtype: "rail",
		name: null,
		tags_json: null,
		geom: "LINESTRING(-0.1 51.5, -0.11 51.51)",
		...over,
	};
}

function train(lineName: string | null): State {
	return { mode: "train", placeId: null, lineName, trainEdgeId: null };
}

function obs(over: Partial<Observation> = {}): Observation {
	return {
		ts: 1_700_000_000,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 12,
		dayOfWeekLocal: 1,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

// Two parallel line geometries. JUB runs north-south through (-0.140, 51.535);
// MET runs east-west through (-0.135, 51.520), well clear of JUB's corridor.
const JUB_GEOM = "LINESTRING(-0.140 51.525, -0.140 51.540)";
const MET_GEOM = "LINESTRING(-0.150 51.520, -0.120 51.520)";

const ON_JUB_LAT = 51.535;
const ON_JUB_LON = -0.14;

describe("buildLineProximityFactor", () => {
	it("returns 0 for non-train states", () => {
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn({ mode: "walking", placeId: null, lineName: null, trainEdgeId: null }, o)).toBe(0);
		expect(fn({ mode: "stationary", placeId: 1, lineName: null, trainEdgeId: null }, o)).toBe(0);
	});

	it("returns 0 for train @ unknown_rail", () => {
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn(train("unknown_rail"), o)).toBe(0);
	});

	it("returns 0 when GPS is null (route-rail-evidence's domain, not ours)", () => {
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: null });
		expect(fn(train("Jubilee Line"), o)).toBe(0);
	});

	it("BOOSTS train @ L when GPS is on L's track", () => {
		const graph = buildRouteGraph(
			[
				line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM }),
				line({ osm_id: 2n, name: "Metropolitan Line", subtype: "subway", geom: MET_GEOM }),
			],
			[],
		);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn(train("Jubilee Line"), o)).toBeGreaterThan(0);
	});

	it("PENALISES train @ L when GPS is far from any L edge in the graph", () => {
		const graph = buildRouteGraph(
			[
				line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM }),
				line({ osm_id: 2n, name: "Metropolitan Line", subtype: "subway", geom: MET_GEOM }),
			],
			[],
		);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		// User is on Jubilee's corridor — Met track is ~1.7 km away.
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn(train("Metropolitan Line"), o)).toBeLessThan(0);
	});

	it("returns 0 when graph has no edges for line L at all (no Victoria edges in graph)", () => {
		// Sole purpose: NEVER unfairly penalise a line that the graph
		// doesn't model. If the L doesn't appear in the local route
		// graph (e.g. partial download), we shouldn't pretend distance
		// is meaningful.
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn(train("Victoria Line"), o)).toBe(0);
	});

	it("on shared track, both lines get the BOOST (composite tag membership)", () => {
		// Single way carrying both Met and Jubilee — Wembley Park → Finchley Road.
		const graph = buildRouteGraph(
			[
				line({
					osm_id: 1n,
					name: "Jubilee and Metropolitan Lines",
					subtype: "subway",
					geom: JUB_GEOM,
				}),
			],
			[],
		);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		const jubScore = fn(train("Jubilee Line"), o);
		const metScore = fn(train("Metropolitan Line"), o);
		expect(jubScore).toBeGreaterThan(0);
		expect(metScore).toBeGreaterThan(0);
		expect(jubScore).toBe(metScore);
	});
});
