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
 *  offset between a station's named node (the named building or
 *  street-level entrance) and the nearest track polyline. For
 *  surface rail this is ~20-80 m; for tube stations the named node
 *  is at the street-level entrance and the track polyline runs
 *  through a tunnel often 150-300 m horizontally beneath. Using
 *  300 m catches both regimes; the trade-off is some over-inclusion
 *  near parallel lines (acceptable per the doc-comment intro). */
const MAX_DIST_M = 300;

/** TTL on the in-process line→stations cache. Beyond this the
 *  cached result is refetched. Lines rarely change; a long TTL is
 *  fine. The pod restarts on every deploy anyway. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map<string, { stations: Station[]; cachedAt: number }>();

/** Reset the cache. Test-only — production code never calls this. */
export function _resetStationsOnLineCache(): void {
	cache.clear();
	allStationsCache = null;
}

/** All railway-station points, cached for the life of the process.
 *  Loaded lazily on the first `stationsOnLine` call. ~1200 rows for
 *  the user's mirrored area; fits comfortably in memory and amortises
 *  the per-line cost away from the request path.
 *
 *  We pre-fetch all stations rather than per-line-bbox query because
 *  a London-wide MBR query against a million-row osm_points table
 *  takes ~30+ s even when only ~100 stations match — the spatial
 *  index pre-filter is poorly-suited to bboxes spanning ~30 km on a
 *  side. One small `WHERE feature_type='railway' AND subtype='station'`
 *  query (~1 s) plus an in-JS filter per line is ~10× faster than
 *  per-line bbox queries. */
let allStationsCache: Promise<StationCandidate[]> | null = null;

async function loadAllRailwayStations(): Promise<StationCandidate[]> {
	if (allStationsCache !== null) return allStationsCache;
	allStationsCache = (async () => {
		const rows = (await db()
			.selectFrom("osm_points")
			.where("feature_type", "=", "railway")
			.where("subtype", "=", "station")
			.select(["name", sql<number>`ST_Y(geom)`.as("lat"), sql<number>`ST_X(geom)`.as("lon")])
			.execute()) as Array<{ name: string | null; lat: number; lon: number }>;
		return rows
			.filter((r): r is { name: string; lat: number; lon: number } => r.name !== null)
			.map((r) => ({ name: r.name, lat: Number(r.lat), lon: Number(r.lon) }));
	})();
	return allStationsCache;
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
	return pointToLineDistanceMParsed(pointLat, pointLon, parseLineStringWkt(wkt));
}

/**
 * Distance (m) from a point to a polyline, given the polyline already
 * parsed to `[lat, lon]` pairs. Internal helper for
 * `pointToLineDistanceM`; the equirectangular kernel is the same.
 */
function pointToLineDistanceMParsed(
	pointLat: number,
	pointLon: number,
	coords: ReadonlyArray<readonly [number, number]>,
): number {
	if (coords.length < 2) return Infinity;
	let min = Infinity;
	for (let i = 1; i < coords.length; i++) {
		const d = pointToSegmentM(pointLat, pointLon, coords[i - 1], coords[i]);
		if (d < min) min = d;
	}
	return min;
}

/** WKT LINESTRING parser. Returns `[lat, lon]` pairs. */
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

function pointToSegmentM(
	pLat: number,
	pLon: number,
	a: readonly [number, number],
	b: readonly [number, number],
): number {
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

	// Step 1: get all ways of this line. The osm_lines.name index
	// (added migration v...) makes this fast (~250 ms for a typical
	// London tube line with 100-200 ways).
	const wayRows = (await db()
		.selectFrom("osm_lines")
		.where("feature_type", "=", "railway")
		.where("name", "=", lineName)
		.select([sql<string>`ST_AsText(geom)`.as("wkt")])
		.execute()) as Array<{ wkt: string }>;

	if (wayRows.length === 0) {
		cache.set(lineName, { stations: [], cachedAt: Date.now() });
		return [];
	}

	// Step 2: load all railway stations (cached process-wide; first
	// call ~1 s, subsequent calls instant). Filtering an in-memory
	// 1200-row station list against a line's ways is ~10× faster
	// than a per-line MBR query because the spatial index is
	// poorly-suited to bboxes spanning many km on a side.
	const allStations = await loadAllRailwayStations();

	// Step 3: proximity-filter the cached station list by per-way
	// distance computed in pure JS.
	const stations = filterStationsByLineProximity(
		allStations,
		wayRows.map((w) => ({ wkt: w.wkt })),
	);

	cache.set(lineName, { stations, cachedAt: Date.now() });
	return stations;
}
