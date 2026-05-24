/**
 * `stationsOnLine` — given a named rail line, return the set of
 * stations that line serves.
 *
 * Today's `linesAtPoint` answers the inverse question (which lines
 * run near a given point); the planned HMM hard-zero transition
 * rule "line L cannot serve focus place P" requires the membership
 * direction (which stations does L serve?).
 *
 * The local OSM mirror does not ingest relation members beyond way
 * geometry, so we infer membership from spatial proximity: a station
 * point that lies within `MAX_DIST_M` of any way of the line counts
 * as served. The error mode is over-inclusion (e.g. a station near a
 * passing-but-not-stopping line), not under-inclusion. Acceptable
 * for the HMM hard-zero rule, which uses station-graph membership as
 * a NEGATIVE constraint ("if station S is NOT served by line L, then
 * the transition is impossible"). False positives loosen the
 * constraint (don't apply the hard-zero when we should); false
 * negatives would incorrectly forbid valid transitions. Better to
 * over-include here.
 *
 * Results are cached in-process for `CACHE_TTL_MS`; the underlying
 * osm_lines / osm_points change only when the OSM mirror refreshes,
 * which is much slower than the cache TTL.
 */

import { sql } from "kysely";
import { db } from "../db/pool.js";

export interface Station {
	name: string;
	lat: number;
	lon: number;
}

/** Internal: a station candidate as returned by an osm_points scan,
 *  before the per-line proximity filter is applied. */
export interface StationCandidate {
	name: string;
	lat: number;
	lon: number;
}

/** Internal: a single rail-line way's geometry, expressed as a WKT
 *  LINESTRING. Exported only so the proximity-filter unit tests can
 *  construct test data without going through SQL. */
export interface WayGeometry {
	wkt: string;
}

/** Max metres from a station point to any way of the line for the
 *  station to count as "served by" the line. Sized to absorb the
 *  typical offset between a station's named node (centre of the
 *  building / concourse) and the nearest track polyline (rails run
 *  through the platform area, often 20-80 m from the named node in
 *  large interchanges). */
const MAX_DIST_M = 120;

/** TTL on the in-process line→stations cache. Beyond this the
 *  cached result is refetched. Lines rarely change; a long TTL is
 *  fine. The pod restarts on every deploy anyway. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map<string, { stations: Station[]; cachedAt: number }>();

/** Reset the cache. Test-only — production code never calls this. */
export function _resetStationsOnLineCache(): void {
	cache.clear();
}

/**
 * Distance (m) from a point to a WKT LINESTRING, computed in pure JS
 * via degree-to-metre conversion (small-radius equirectangular
 * approximation; sub-percent error at city-scale distances).
 *
 * Exported so the proximity-filter unit tests can use the same
 * distance computation as production.
 */
export function pointToLineDistanceM(pointLat: number, pointLon: number, wkt: string): number {
	const coords = parseLineStringWkt(wkt);
	if (coords.length < 2) return Infinity;
	let min = Infinity;
	for (let i = 1; i < coords.length; i++) {
		const d = pointToSegmentM(pointLat, pointLon, coords[i - 1], coords[i]);
		if (d < min) min = d;
	}
	return min;
}

function parseLineStringWkt(wkt: string): Array<[number, number]> {
	// WKT: LINESTRING(lon1 lat1,lon2 lat2,...)
	const inner = wkt.match(/^LINESTRING\s*\(([^)]+)\)$/i)?.[1];
	if (!inner) return [];
	return inner.split(",").map((pair) => {
		const [lon, lat] = pair.trim().split(/\s+/).map(Number);
		return [lat, lon] as [number, number];
	});
}

const M_PER_DEG_LAT = 111_320;

function metersPerDegLon(lat: number): number {
	return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

function pointToSegmentM(pLat: number, pLon: number, a: [number, number], b: [number, number]): number {
	// Equirectangular projection at the segment midpoint — accurate
	// for sub-km distances. Convert to metres then standard
	// point-to-segment distance in 2D.
	const refLat = (a[0] + b[0]) / 2;
	const mPerLat = M_PER_DEG_LAT;
	const mPerLon = metersPerDegLon(refLat);
	const ax = (a[1] - 0) * mPerLon;
	const ay = (a[0] - 0) * mPerLat;
	const bx = (b[1] - 0) * mPerLon;
	const by = (b[0] - 0) * mPerLat;
	const px = (pLon - 0) * mPerLon;
	const py = (pLat - 0) * mPerLat;
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
	if (t < 0) t = 0;
	else if (t > 1) t = 1;
	const projX = ax + t * dx;
	const projY = ay + t * dy;
	const distX = px - projX;
	const distY = py - projY;
	return Math.hypot(distX, distY);
}

/**
 * Pure-function filter: keep station candidates within MAX_DIST_M of
 * any of the provided ways. Dedupes by station name, preserves input
 * order.
 */
export function filterStationsByLineProximity(
	stations: readonly StationCandidate[],
	ways: readonly WayGeometry[],
): Station[] {
	if (stations.length === 0 || ways.length === 0) return [];
	const seen = new Set<string>();
	const result: Station[] = [];
	for (const s of stations) {
		if (seen.has(s.name)) continue;
		for (const w of ways) {
			if (pointToLineDistanceM(s.lat, s.lon, w.wkt) <= MAX_DIST_M) {
				seen.add(s.name);
				result.push({ name: s.name, lat: s.lat, lon: s.lon });
				break;
			}
		}
	}
	return result;
}

/**
 * Return the set of stations a named rail line serves.
 *
 * Process:
 *   1. Fetch all `osm_lines` rows where `name === lineName` and
 *      `feature_type === 'railway'` (the rail-line's way geometry,
 *      possibly fragmented across many ways).
 *   2. Compute the line's bounding box (envelope of all way geom).
 *   3. Fetch all `osm_points` stations within that bbox.
 *   4. Filter station candidates to those within `MAX_DIST_M` of any
 *      way (`filterStationsByLineProximity`).
 *   5. Dedupe by station name.
 *
 * In-process cached for `CACHE_TTL_MS`.
 */
export async function stationsOnLine(lineName: string): Promise<Station[]> {
	const cached = cache.get(lineName);
	if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
		return cached.stations;
	}

	// Step 1: get all ways of this line. The mirror stores rail
	// ways under feature_type='railway'.
	const wayRows = (await db()
		.selectFrom("osm_lines")
		.where("feature_type", "=", "railway")
		.where("name", "=", lineName)
		.select([sql<string>`ST_AsText(geom)`.as("wkt"), sql<string>`ST_AsText(ST_Envelope(geom))`.as("envelope_wkt")])
		.execute()) as Array<{ wkt: string; envelope_wkt: string }>;

	if (wayRows.length === 0) {
		cache.set(lineName, { stations: [], cachedAt: Date.now() });
		return [];
	}

	// Step 2: compute the union bbox of all ways' envelopes.
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLon = Infinity;
	let maxLon = -Infinity;
	for (const w of wayRows) {
		const env = parseEnvelopeWkt(w.envelope_wkt);
		if (env === null) continue;
		if (env.minLat < minLat) minLat = env.minLat;
		if (env.maxLat > maxLat) maxLat = env.maxLat;
		if (env.minLon < minLon) minLon = env.minLon;
		if (env.maxLon > maxLon) maxLon = env.maxLon;
	}
	if (!Number.isFinite(minLat)) {
		cache.set(lineName, { stations: [], cachedAt: Date.now() });
		return [];
	}

	// Pad the bbox by MAX_DIST_M so stations near the line's
	// endpoints aren't missed.
	const padLat = MAX_DIST_M / M_PER_DEG_LAT;
	const padLon = MAX_DIST_M / metersPerDegLon((minLat + maxLat) / 2);
	const bboxPolyWkt = `POLYGON((${minLon - padLon} ${minLat - padLat},${maxLon + padLon} ${minLat - padLat},${maxLon + padLon} ${maxLat + padLat},${minLon - padLon} ${maxLat + padLat},${minLon - padLon} ${minLat - padLat}))`;

	// Step 3: fetch station candidates in the bbox. Stations live
	// under feature_type='railway' subtype='station' in the OSM mirror
	// (not feature_type='station' — that's not a thing in the schema).
	const stationRows = (await db()
		.selectFrom("osm_points")
		.where("feature_type", "=", "railway")
		.where("subtype", "=", "station")
		.where(sql<boolean>`MBRIntersects(geom, ST_GeomFromText(${bboxPolyWkt}, 4326))`)
		.select(["name", sql<number>`ST_Y(geom)`.as("lat"), sql<number>`ST_X(geom)`.as("lon")])
		.execute()) as Array<{ name: string | null; lat: number; lon: number }>;

	const candidates: StationCandidate[] = stationRows
		.filter((r): r is { name: string; lat: number; lon: number } => r.name !== null)
		.map((r) => ({ name: r.name, lat: Number(r.lat), lon: Number(r.lon) }));

	// Step 4 + 5: proximity filter + dedupe.
	const stations = filterStationsByLineProximity(
		candidates,
		wayRows.map((w) => ({ wkt: w.wkt })),
	);

	cache.set(lineName, { stations, cachedAt: Date.now() });
	return stations;
}

function parseEnvelopeWkt(wkt: string): { minLat: number; maxLat: number; minLon: number; maxLon: number } | null {
	// ST_Envelope returns a POLYGON with 5 vertices (the closed
	// bbox). WKT: POLYGON((minLon minLat,maxLon minLat,maxLon
	// maxLat,minLon maxLat,minLon minLat))
	const inner = wkt.match(/^POLYGON\s*\(\(([^)]+)\)\)$/i)?.[1];
	if (!inner) return null;
	const points = inner.split(",").map((pair) => pair.trim().split(/\s+/).map(Number));
	if (points.length < 4) return null;
	const lons = points.map((p) => p[0]);
	const lats = points.map((p) => p[1]);
	return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
}
