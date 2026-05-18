/**
 * Route-geometry fetch for an identified rail line.
 *
 * Once a journey is classified as a train run on a known line,
 * rail-snap needs the line's actual track geometry to project fixes
 * onto. `osm_lines` stores each way as a LINESTRING; this covers:
 *
 *   - `parseLineStringWkt` — turning the `ST_AsText(geom)` WKT a
 *     rail way comes back as into a {lat,lon}[] vertex list. WKT
 *     coordinate order is `lon lat`, the reverse of how we name them.
 *   - `buildLineGeometryQuery` — the SQL must filter by line name and
 *     use the SPATIAL index (MBRIntersects) over the corridor bbox,
 *     not a per-row scan.
 */

import { Kysely, sql } from "kysely";
import { MariadbDialect } from "kysely-mariadb";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/tables.js";
import {
	buildLineGeometryQuery,
	buildRouteNamesQuery,
	parseLineStringWkt,
	parseOverpassRelation,
} from "../src/geo/osm-local.js";

function compileOnlyKysely(): Kysely<Database> {
	return new Kysely<Database>({ dialect: new MariadbDialect({ mariadb: {} as never }) });
}

describe("parseLineStringWkt", () => {
	it("parses a LINESTRING, mapping WKT `lon lat` order to {lat,lon}", () => {
		const pts = parseLineStringWkt("LINESTRING(5.1 50.2,5.3 50.4,5.5 50.6)");
		expect(pts).toEqual([
			{ lat: 50.2, lon: 5.1 },
			{ lat: 50.4, lon: 5.3 },
			{ lat: 50.6, lon: 5.5 },
		]);
	});

	it("tolerates whitespace after commas", () => {
		const pts = parseLineStringWkt("LINESTRING (5.1 50.2, 5.3 50.4)");
		expect(pts).toEqual([
			{ lat: 50.2, lon: 5.1 },
			{ lat: 50.4, lon: 5.3 },
		]);
	});

	it("returns an empty array for non-LINESTRING or malformed input", () => {
		expect(parseLineStringWkt("")).toEqual([]);
		expect(parseLineStringWkt("POINT(5 50)")).toEqual([]);
		expect(parseLineStringWkt("LINESTRING EMPTY")).toEqual([]);
		expect(parseLineStringWkt("garbage")).toEqual([]);
	});
});

describe("buildLineGeometryQuery", () => {
	const bbox = { minLat: 50.0, maxLat: 50.5, minLon: 5.0, maxLon: 5.5 };

	it("matches ways by any of the supplied line names", () => {
		const q = buildLineGeometryQuery(compileOnlyKysely(), bbox, ["Northern", "Mildmay line"]);
		const { sql: compiled, parameters } = q.compile();
		expect(compiled).toContain("`name` in");
		expect(parameters).toContain("Northern");
		expect(parameters).toContain("Mildmay line");
	});

	it("uses MBRIntersects so the spatial index covers the corridor bbox", () => {
		const q = buildLineGeometryQuery(compileOnlyKysely(), bbox, ["Northern"]);
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("MBRIntersects");
	});

	it("selects the geometry as WKT via ST_AsText", () => {
		const q = buildLineGeometryQuery(compileOnlyKysely(), bbox, ["Northern"]);
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("ST_AsText");
	});

	it("restricts to rail-class features", () => {
		const q = buildLineGeometryQuery(compileOnlyKysely(), bbox, ["Northern"]);
		const { sql: compiled, parameters } = q.compile();
		expect(compiled).toContain("`feature_type` =");
		expect(parameters).toContain("railway");
	});

	it("also matches ways via route-relation membership (osm_way_routes)", () => {
		// A line's track ways often carry the line name only on the
		// route relation. The query must additionally pull ways that
		// are members of a relation named for the line.
		const q = buildLineGeometryQuery(compileOnlyKysely(), bbox, ["Northern"]);
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("osm_way_routes");
	});
});

describe("buildRouteNamesQuery", () => {
	const bbox = { minLat: 50.0, maxLat: 50.5, minLon: 5.0, maxLon: 5.5 };

	it("bridges a way name to its route-relation names via osm_way_routes", () => {
		const q = buildRouteNamesQuery(compileOnlyKysely(), bbox, "North London line");
		const { sql: compiled, parameters } = q.compile();
		expect(compiled).toContain("osm_way_routes");
		expect(compiled).toContain("`route_name`");
		expect(parameters).toContain("North London line");
	});

	it("stays index-accelerated via MBRIntersects on the corridor bbox", () => {
		const q = buildRouteNamesQuery(compileOnlyKysely(), bbox, "North London line");
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("MBRIntersects");
	});
});

describe("parseOverpassRelation", () => {
	it("extracts name, route type and the way members of a rail route", () => {
		const r = parseOverpassRelation({
			type: "relation",
			id: 42,
			tags: { type: "route", route: "subway", name: "Test Line" },
			members: [
				{ type: "way", ref: 100, role: "" },
				{ type: "node", ref: 200, role: "stop" },
				{ type: "way", ref: 101, role: "" },
			],
		});
		expect(r).not.toBeNull();
		expect(r?.name).toBe("Test Line");
		expect(r?.route_type).toBe("subway");
		// Node members are dropped — only way members carry track.
		expect(r?.memberWayIds).toEqual([100, 101]);
	});

	it("falls back to ref when the relation has no name", () => {
		const r = parseOverpassRelation({
			type: "relation",
			id: 7,
			tags: { type: "route", route: "train", ref: "NLL" },
			members: [{ type: "way", ref: 1, role: "" }],
		});
		expect(r?.name).toBe("NLL");
	});

	it("returns null for a non-rail route, no route tag, no name, or no way members", () => {
		const base = { type: "relation" as const, id: 1, members: [{ type: "way" as const, ref: 1, role: "" }] };
		expect(parseOverpassRelation({ ...base, tags: { route: "bus", name: "Bus 9" } })).toBeNull();
		expect(parseOverpassRelation({ ...base, tags: { name: "No route tag" } })).toBeNull();
		expect(parseOverpassRelation({ ...base, tags: { route: "subway" } })).toBeNull();
		expect(
			parseOverpassRelation({ type: "relation", id: 1, tags: { route: "subway", name: "Empty" }, members: [] }),
		).toBeNull();
	});
});

void sql;
