/**
 * Route graph loader: pull osm_lines + osm_points rows for a bbox
 * from the local OSM mirror and feed them into `buildRouteGraph`.
 *
 * Phase 0 of the route-aware decoder. For now loads ALL feature
 * types so the resulting graph can be filtered downstream. Future
 * callers (Phase 1) may pre-filter to specific subtypes (rail-only
 * for train decoding) to keep the graph compact.
 */

import { sql } from "kysely";
import { db } from "../db/pool.js";
import { buildRouteGraph, type RawOsmLine, type RawOsmPoint, type RouteGraph } from "./route-graph.js";

export interface Bbox {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}

/** Build a WKT POLYGON from a bbox, suitable for MBRIntersects. */
function bboxPolygonWkt(b: Bbox): string {
	return (
		"POLYGON((" +
		`${b.minLon} ${b.minLat},${b.maxLon} ${b.minLat},` +
		`${b.maxLon} ${b.maxLat},${b.minLon} ${b.maxLat},` +
		`${b.minLon} ${b.minLat}))`
	);
}

/** Expand a bbox by N metres. Useful when bounding-box-clipping
 *  ways near the edge — without padding, a way that exits the
 *  bbox on one end loses connectivity. */
export function expandBbox(b: Bbox, marginM: number): Bbox {
	const dLat = marginM / 111_320;
	const dLon = marginM / (111_320 * Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180));
	return {
		minLat: b.minLat - dLat,
		maxLat: b.maxLat + dLat,
		minLon: b.minLon - dLon,
		maxLon: b.maxLon + dLon,
	};
}

/** Compute a bbox enclosing the supplied fixes, expanded by the
 *  given margin. Returns null when the input is empty. */
export function bboxFromFixes(fixes: readonly { lat: number; lon: number }[], marginM = 1500): Bbox | null {
	if (fixes.length === 0) return null;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	let minLon = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	for (const f of fixes) {
		minLat = Math.min(minLat, f.lat);
		maxLat = Math.max(maxLat, f.lat);
		minLon = Math.min(minLon, f.lon);
		maxLon = Math.max(maxLon, f.lon);
	}
	return expandBbox({ minLat, maxLat, minLon, maxLon }, marginM);
}

export interface LoadRouteGraphOpts {
	/** Optional feature-type filter — when set, only rows with
	 *  `feature_type IN (...)` are loaded. Use this when the consumer
	 *  only needs rail (`["railway"]`) or only roads
	 *  (`["highway"]`); skips loading unrelated geometry and keeps
	 *  the graph small. Defaults to no filter (loads everything). */
	featureTypes?: readonly string[];
	/** Hard cap on osm_lines rows to load. Defaults to 50000 — large
	 *  enough for central London, small enough to keep the build
	 *  bounded. */
	lineRowLimit?: number;
	/** Hard cap on osm_points rows to load. Defaults to 10000. */
	pointRowLimit?: number;
}

/** Fetch the raw osm_lines + osm_points rows for a bbox from the local
 *  OSM mirror — the deterministic inputs to `buildRouteGraph`. Split out
 *  from `loadRouteGraphForBbox` so a fixture-capture path can serialize
 *  the same rows and rebuild an identical graph offline. */
export async function loadRawOsmForBbox(
	bbox: Bbox,
	opts: LoadRouteGraphOpts = {},
): Promise<{ lines: RawOsmLine[]; points: RawOsmPoint[] }> {
	const poly = bboxPolygonWkt(bbox);
	const lineLimit = opts.lineRowLimit ?? 50_000;
	const pointLimit = opts.pointRowLimit ?? 10_000;
	const featureTypes = opts.featureTypes;

	let lines: RawOsmLine[];
	if (featureTypes !== undefined && featureTypes.length > 0) {
		lines = (
			await sql<RawOsmLine>`
				SELECT osm_id, osm_type, feature_type, subtype, name, tags_json, ST_AsText(geom) AS geom
				FROM osm_lines
				WHERE feature_type IN (${sql.join(featureTypes)})
				  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
				LIMIT ${sql.raw(String(lineLimit))}
			`.execute(db())
		).rows;
	} else {
		lines = (
			await sql<RawOsmLine>`
				SELECT osm_id, osm_type, feature_type, subtype, name, tags_json, ST_AsText(geom) AS geom
				FROM osm_lines
				WHERE MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
				LIMIT ${sql.raw(String(lineLimit))}
			`.execute(db())
		).rows;
	}

	const pointRows = (
		await sql<RawOsmPoint & { wkt: string }>`
			SELECT osm_id, osm_type, name, tags_json, ST_AsText(geom) AS wkt
			FROM osm_points
			WHERE MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
			LIMIT ${sql.raw(String(pointLimit))}
		`.execute(db())
	).rows;

	// Decode POINT(lon lat) → {lat, lon}.
	const points: RawOsmPoint[] = [];
	for (const r of pointRows) {
		const m = /^POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)\s*$/i.exec(r.wkt);
		if (m === null) continue;
		const lon = Number(m[1]);
		const lat = Number(m[2]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		points.push({ ...r, lat, lon });
	}

	return { lines, points };
}

/** Load the route graph for a bbox from the local OSM mirror.
 *  Wraps the SQL fetch and the pure `buildRouteGraph` call. */
export async function loadRouteGraphForBbox(bbox: Bbox, opts: LoadRouteGraphOpts = {}): Promise<RouteGraph> {
	const { lines, points } = await loadRawOsmForBbox(bbox, opts);
	return buildRouteGraph(lines, points);
}
