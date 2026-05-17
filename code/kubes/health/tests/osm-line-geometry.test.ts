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
import { buildLineGeometryQuery, parseLineStringWkt } from "../src/geo/osm-local.js";

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

	it("filters by exact line name", () => {
		const q = buildLineGeometryQuery(compileOnlyKysely(), bbox, "Northern");
		const { sql: compiled, parameters } = q.compile();
		expect(compiled).toContain("`name` =");
		expect(parameters).toContain("Northern");
	});

	it("uses MBRIntersects so the spatial index covers the corridor bbox", () => {
		const q = buildLineGeometryQuery(compileOnlyKysely(), bbox, "Northern");
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("MBRIntersects");
	});

	it("selects the geometry as WKT via ST_AsText", () => {
		const q = buildLineGeometryQuery(compileOnlyKysely(), bbox, "Northern");
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("ST_AsText");
	});

	it("restricts to rail-class features", () => {
		const q = buildLineGeometryQuery(compileOnlyKysely(), bbox, "Northern");
		const { sql: compiled, parameters } = q.compile();
		expect(compiled).toContain("`feature_type` =");
		expect(parameters).toContain("railway");
	});
});

void sql;
