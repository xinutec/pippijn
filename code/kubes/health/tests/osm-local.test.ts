/**
 * Tests for the pure-function layer of the local OSM mirror.
 *
 * The DB-touching helpers (ensureCoverage, queryFeatures) need a real
 * MariaDB with ST_Distance_Sphere to test meaningfully; those are
 * verified end-to-end via analyze-day on production data after
 * deploy. This file covers the parts we can test in isolation:
 *
 *   - coverage-containment math
 *   - fetch-bbox computation
 *   - Overpass element → feature parsing
 *   - Overpass query string assembly
 */

import { describe, expect, it } from "vitest";
import {
	buildOverpassQuery,
	type CoverageRow,
	fetchBboxAround,
	isPointCovered,
	parseOverpassElement,
} from "../src/geo/osm-local.js";

describe("isPointCovered", () => {
	it("returns false against an empty coverage list", () => {
		expect(isPointCovered(51.5, -0.1, 400, [])).toBe(false);
	});

	it("returns true when the search circle is fully inside a coverage box", () => {
		const covers: CoverageRow[] = [{ min_lat: 51.0, max_lat: 52.0, min_lon: -1.0, max_lon: 0.5 }];
		expect(isPointCovered(51.5, -0.1, 400, covers)).toBe(true);
	});

	it("returns false when the search circle extends beyond a coverage box edge", () => {
		// 400m radius ≈ 0.0036° lat. Box extends only 0.001° above query
		// → search circle pokes out the top.
		const covers: CoverageRow[] = [{ min_lat: 50.0, max_lat: 51.501, min_lon: -1.0, max_lon: 0.5 }];
		expect(isPointCovered(51.5, -0.1, 400, covers)).toBe(false);
	});

	it("returns true when one of multiple coverage boxes contains the search circle", () => {
		const covers: CoverageRow[] = [
			{ min_lat: 60.0, max_lat: 61.0, min_lon: 0.0, max_lon: 1.0 }, // miss
			{ min_lat: 51.0, max_lat: 52.0, min_lon: -1.0, max_lon: 0.5 }, // covers
		];
		expect(isPointCovered(51.5, -0.1, 400, covers)).toBe(true);
	});

	it("requires full containment — partial overlap is not enough", () => {
		// 400m radius circle straddles the boundary at lat 51.5
		const covers: CoverageRow[] = [{ min_lat: 51.5, max_lat: 52.0, min_lon: -1.0, max_lon: 0.5 }];
		expect(isPointCovered(51.5, -0.1, 400, covers)).toBe(false);
	});

	it("scales latitude correction with the query latitude", () => {
		// At the equator, 400m east-west is the same number of degrees
		// as 400m north-south. Near London (lat 51.5), 400m east-west
		// is about 1.6× more degrees of longitude (because cos(51.5°) ≈ 0.62).
		// The function must account for that — otherwise a coverage box
		// that's "just wide enough" at the equator would falsely cover
		// a London query.
		const tightBox: CoverageRow[] = [
			// Box that's exactly 400m wide in lon-degrees at the equator
			{ min_lat: 51.0, max_lat: 52.0, min_lon: -0.0036, max_lon: 0.0036 },
		];
		// At lat 51.5, 400m radius needs ~0.0058° of longitude. The
		// 0.0036°-wide box doesn't cover it.
		expect(isPointCovered(51.5, 0.0, 400, tightBox)).toBe(false);
	});
});

describe("fetchBboxAround", () => {
	it("centres a 10km box on the query point", () => {
		const b = fetchBboxAround(51.5, -0.1);
		expect(b.minLat).toBeLessThan(51.5);
		expect(b.maxLat).toBeGreaterThan(51.5);
		expect(b.minLon).toBeLessThan(-0.1);
		expect(b.maxLon).toBeGreaterThan(-0.1);
	});

	it("respects the half-width parameter", () => {
		const small = fetchBboxAround(51.5, -0.1, 1000);
		const big = fetchBboxAround(51.5, -0.1, 10_000);
		expect(big.maxLat - big.minLat).toBeGreaterThan(small.maxLat - small.minLat);
	});

	it("compensates for latitude in longitude span", () => {
		// At higher latitudes, the same metre-distance is more degrees
		// of longitude. fetchBboxAround must reflect that.
		const london = fetchBboxAround(51.5, 0.0, 5000);
		const equator = fetchBboxAround(0.0, 0.0, 5000);
		const londonWidth = london.maxLon - london.minLon;
		const equatorWidth = equator.maxLon - equator.minLon;
		expect(londonWidth).toBeGreaterThan(equatorWidth);
	});

	it("produces a box that fully contains a search circle of the same radius", () => {
		// Sanity: the box we fetch for radius R should be safe coverage
		// for queries up to radius R at the centre.
		const bbox = fetchBboxAround(51.5, -0.1, 5000);
		const covered = isPointCovered(51.5, -0.1, 5000, [
			{ min_lat: bbox.minLat, max_lat: bbox.maxLat, min_lon: bbox.minLon, max_lon: bbox.maxLon },
		]);
		expect(covered).toBe(true);
	});
});

describe("parseOverpassElement", () => {
	it("parses a station node as feature_type=station with POINT geometry", () => {
		const f = parseOverpassElement({
			type: "node",
			id: 12345,
			lat: 51.5331,
			lon: -0.1259,
			tags: { railway: "station", name: "King's Cross St Pancras" },
		});
		expect(f).not.toBeNull();
		expect(f?.feature_type).toBe("railway");
		expect(f?.subtype).toBe("station");
		expect(f?.name).toBe("King's Cross St Pancras");
		expect(f?.geom_wkt).toBe("POINT(-0.1259 51.5331)");
	});

	it("parses a way as LINESTRING using its geometry vertices", () => {
		const f = parseOverpassElement({
			type: "way",
			id: 67890,
			tags: { highway: "motorway", name: "M25" },
			geometry: [
				{ lat: 51.5, lon: -0.5 },
				{ lat: 51.6, lon: -0.4 },
				{ lat: 51.7, lon: -0.3 },
			],
		});
		expect(f).not.toBeNull();
		expect(f?.feature_type).toBe("highway");
		expect(f?.subtype).toBe("motorway");
		expect(f?.geom_wkt).toBe("LINESTRING(-0.5 51.5,-0.4 51.6,-0.3 51.7)");
	});

	it("buckets a railway tag as feature_type=railway", () => {
		const f = parseOverpassElement({
			type: "way",
			id: 1,
			tags: { railway: "subway", name: "Jubilee Line" },
			geometry: [
				{ lat: 51.5, lon: -0.1 },
				{ lat: 51.6, lon: -0.2 },
			],
		});
		expect(f?.feature_type).toBe("railway");
		expect(f?.subtype).toBe("subway");
	});

	it("uses tag-priority order — railway wins over highway when both present", () => {
		const f = parseOverpassElement({
			type: "way",
			id: 1,
			tags: { railway: "rail", highway: "service" },
			geometry: [
				{ lat: 51.5, lon: -0.1 },
				{ lat: 51.6, lon: -0.2 },
			],
		});
		expect(f?.feature_type).toBe("railway");
	});

	it("returns null for an element with no relevant tags", () => {
		expect(parseOverpassElement({ type: "node", id: 1, lat: 51, lon: -1, tags: { population: "1000" } })).toBeNull();
	});

	it("returns null for a node missing lat/lon", () => {
		expect(parseOverpassElement({ type: "node", id: 1, tags: { railway: "station" } })).toBeNull();
	});

	it("returns null for a way missing geometry", () => {
		expect(parseOverpassElement({ type: "way", id: 1, tags: { highway: "motorway" } })).toBeNull();
	});

	it("falls back to `ref` when name is missing", () => {
		const f = parseOverpassElement({
			type: "way",
			id: 1,
			tags: { highway: "motorway", ref: "A1" },
			geometry: [
				{ lat: 51.5, lon: -0.1 },
				{ lat: 51.6, lon: -0.2 },
			],
		});
		expect(f?.name).toBe("A1");
	});
});

describe("buildOverpassQuery", () => {
	const bbox = { minLat: 51.0, maxLat: 52.0, minLon: -1.0, maxLon: 0.5 };

	it("emits stanzas for both stations (nodes) and rail lines (ways) under feature_type=railway", () => {
		// One Overpass fetch under feature_type=railway should bring
		// back BOTH station nodes and rail-line ways. That way both
		// nearbyStations and linesAtPoint share a single coverage box
		// per area, not two separate ones.
		const q = buildOverpassQuery("railway", bbox);
		expect(q).toContain("[out:json][timeout:25]");
		expect(q).toContain('node["railway"~"^(station|subway_entrance|halt|stop|tram_stop)$"]');
		expect(q).toContain('way["railway"~"^(rail|subway|light_rail|tram|narrow_gauge)$"]');
		expect(q).toContain("51,-1,52,0.5"); // bbox in S,W,N,E order
		expect(q).toContain("out tags geom"); // we need way geometry for ways
	});

	it("emits separate stanzas for landmark sub-tags", () => {
		const q = buildOverpassQuery("landmark", bbox);
		expect(q).toContain('node["amenity"]');
		expect(q).toContain('node["shop"]');
		expect(q).toContain('way["amenity"]');
		expect(q).toContain('way["shop"]');
	});

	it("rejects unknown feature_types up front", () => {
		expect(() => buildOverpassQuery("not_a_thing", bbox)).toThrow();
	});
});
