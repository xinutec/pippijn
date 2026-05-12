/**
 * Local OSM feature mirror.
 *
 * # Why this exists
 *
 * The old `osm_cache` table stored Overpass query responses keyed by
 * `(query_type, lat_rounded, lon_rounded)`. That worked but had two
 * structural problems:
 *
 *   1. The cache key was raw coordinates, so GPS jitter at the same
 *      physical place produced different cache keys → repeated
 *      Overpass calls for "the same desk".
 *   2. Cache misses (and the occasional transient Overpass failure)
 *      surfaced as wrong labels in the dashboard until the negative
 *      cache window expired.
 *
 * # What this does
 *
 * Stores OSM features locally with a spatial index, organised by:
 *
 *   - `osm_coverage` — rows describing bounding boxes we've already
 *     fetched, one per feature_type. Boxes grow lazily as the user
 *     travels into uncovered areas.
 *   - `osm_features` — individual OSM nodes/ways we care about, with
 *     `geom GEOMETRY` so both POINTs (stations) and LINESTRINGs
 *     (roads/rail lines) can share the spatial index. Primary key on
 *     `(osm_type, osm_id)` dedupes when overlapping coverage boxes
 *     return the same feature.
 *
 * The query path becomes:
 *
 *   1. Check if (lat, lon, radius) is fully inside any coverage row
 *      for this feature_type. If yes → go straight to step 3.
 *   2. Fetch a 10 km box around (lat, lon) from Overpass, parse the
 *      features, upsert into `osm_features`, insert a `osm_coverage`
 *      row for the bbox + feature_type.
 *   3. Run a SQL spatial query: `ST_Distance_Sphere(geom, ...) < radius`.
 *
 * Steady-state cost is one indexed SQL query — no network, no
 * transient failures, no negative-cache TTLs. The only Overpass call
 * is on the first visit to a new area.
 *
 * # Scope
 *
 * Replaces Overpass usage for:
 *   - `nearbyStations` (railway=station|subway_entrance)
 *   - `nearbyWays` (highway, railway, waterway, aeroway tags)
 *   - `nearbyLandmarks` (amenity, shop, tourism, leisure tags)
 *   - `linesAtPoint` (railway line names within radius)
 *
 * Does NOT replace `reverseGeocode` — Nominatim has place-name and
 * admin-hierarchy semantics that aren't representable as raw OSM
 * features. That path keeps the existing `osm_cache` table.
 */

import { sql } from "kysely";
import { db } from "../db/pool.js";
import { overpassFetch } from "./osm-overpass.js";

/** A coverage row as read from the DB. */
export interface CoverageRow {
	min_lat: number;
	max_lat: number;
	min_lon: number;
	max_lon: number;
	fetched_at?: Date;
}

/** One degree of latitude is roughly 111 km everywhere. Longitude
 *  varies with latitude — `111 km · cos(lat)`. Good enough for the
 *  small-radius math we do here; we never operate on degrees that
 *  matter at the poles. */
const METERS_PER_DEG_LAT = 111_000;
function metersPerDegLon(lat: number): number {
	return 111_000 * Math.cos((lat * Math.PI) / 180);
}

/**
 * Is the search circle around (lat, lon) with `radiusM` fully inside
 * any of the given coverage rows? Boxes are inclusive on both ends;
 * the search circle is approximated as an axis-aligned bounding box
 * (slightly conservative — at the corners the bbox is bigger than
 * the circle, which is fine for "are we covered" purposes).
 *
 * Returns true if at least one coverage row contains the full search
 * bbox. False otherwise — caller should fetch a new region.
 */
export function isPointCovered(lat: number, lon: number, radiusM: number, coverage: readonly CoverageRow[]): boolean {
	const dLat = radiusM / METERS_PER_DEG_LAT;
	const dLon = radiusM / metersPerDegLon(lat);
	const qMinLat = lat - dLat;
	const qMaxLat = lat + dLat;
	const qMinLon = lon - dLon;
	const qMaxLon = lon + dLon;
	for (const c of coverage) {
		if (c.min_lat <= qMinLat && c.max_lat >= qMaxLat && c.min_lon <= qMinLon && c.max_lon >= qMaxLon) {
			return true;
		}
	}
	return false;
}

/**
 * Compute the bounding box to fetch when (lat, lon) is uncovered.
 * Centres on the query point and extends `halfWidthM` metres in each
 * cardinal direction. 5 km half-width = 10 km box ≈ 100 km² — small
 * enough to keep Overpass payloads modest, big enough that one fetch
 * covers a whole neighbourhood and you don't keep re-fetching every
 * few hundred metres of travel.
 */
export function fetchBboxAround(
	lat: number,
	lon: number,
	halfWidthM = 1000,
): { minLat: number; maxLat: number; minLon: number; maxLon: number } {
	const dLat = halfWidthM / METERS_PER_DEG_LAT;
	const dLon = halfWidthM / metersPerDegLon(lat);
	return {
		minLat: lat - dLat,
		maxLat: lat + dLat,
		minLon: lon - dLon,
		maxLon: lon + dLon,
	};
}

/** A parsed OSM feature ready to be inserted into `osm_features`. */
export interface ParsedFeature {
	osm_id: number;
	osm_type: "node" | "way";
	feature_type: string;
	subtype: string | null;
	name: string | null;
	tags: Record<string, string>;
	geom_wkt: string; // POINT(...) or LINESTRING(...)
}

/** Overpass element shape (subset we use). */
interface OverpassElement {
	type: "node" | "way" | "relation";
	id: number;
	lat?: number;
	lon?: number;
	tags?: Record<string, string>;
	geometry?: Array<{ lat: number; lon: number }>;
}

/** Order of tag precedence for the `feature_type` bucket assignment.
 *  An OSM way tagged both `highway=motorway` and `railway=rail` (rare
 *  but possible — pickup trucks on a rail tunnel) gets bucketed under
 *  the first match. railway wins because the rail signal is rarer and
 *  more informative for our classification. */
const FEATURE_TYPE_RULES: Array<{ tag: string; featureType: string }> = [
	{ tag: "aeroway", featureType: "aeroway" },
	{ tag: "railway", featureType: "railway" },
	{ tag: "highway", featureType: "highway" },
	{ tag: "waterway", featureType: "waterway" },
	{ tag: "amenity", featureType: "landmark" },
	{ tag: "shop", featureType: "landmark" },
	{ tag: "tourism", featureType: "landmark" },
	{ tag: "leisure", featureType: "landmark" },
	{ tag: "building", featureType: "landmark" },
];

/** Translate an Overpass element into our feature row, or null if it
 *  doesn't carry a tag we care about / lacks geometry. */
export function parseOverpassElement(el: OverpassElement): ParsedFeature | null {
	const tags = el.tags ?? {};
	let featureType: string | null = null;
	let subtype: string | null = null;
	for (const rule of FEATURE_TYPE_RULES) {
		if (tags[rule.tag]) {
			featureType = rule.featureType;
			subtype = tags[rule.tag];
			break;
		}
	}
	if (featureType === null) return null;

	let geom_wkt: string;
	if (el.type === "node") {
		if (el.lat === undefined || el.lon === undefined) return null;
		geom_wkt = `POINT(${el.lon} ${el.lat})`;
	} else if (el.type === "way") {
		if (!el.geometry || el.geometry.length < 2) return null;
		const coords = el.geometry.map((p) => `${p.lon} ${p.lat}`).join(",");
		geom_wkt = `LINESTRING(${coords})`;
	} else {
		return null; // relations not supported
	}

	return {
		osm_id: el.id,
		osm_type: el.type,
		feature_type: featureType,
		subtype,
		name: tags.name ?? tags.ref ?? null,
		tags,
		geom_wkt,
	};
}

/**
 * Build the Overpass query body for one feature_type over a bbox.
 *
 * The query language uses `(south, west, north, east)` for bbox in
 * `out:json` mode. We ask for nodes AND ways AND lookup geometry
 * because rail/road features are linear and need the polyline; the
 * single `out tags geom;` line returns both per-element tags and the
 * way's vertex list.
 */
export function buildOverpassQuery(
	featureType: string,
	bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
): string {
	const b = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
	// Per feature_type, the tag filters that should land in this bucket
	// when we'd later parse the result. Multiple node/way queries are
	// combined via Overpass union syntax `(...)`. Each feature_type is
	// the OSM tag-namespace (railway, highway, aeroway, …) so one fetch
	// brings in both stations AND rail lines for "railway", both road
	// ways AND a few road-related nodes for "highway", etc.
	const filterFor: Record<string, string[]> = {
		railway: [
			'node["railway"~"^(station|subway_entrance|halt|stop|tram_stop)$"]',
			'way["railway"~"^(rail|subway|light_rail|tram|narrow_gauge)$"]',
		],
		highway: [
			'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|footway|cycleway|path|pedestrian|track)$"]',
		],
		aeroway: ['node["aeroway"]', 'way["aeroway"]'],
		waterway: ['way["waterway"]'],
		landmark: [
			'node["amenity"]',
			'node["shop"]',
			'node["tourism"]',
			'node["leisure"]',
			'way["amenity"]',
			'way["shop"]',
			'way["tourism"]',
			'way["leisure"]',
		],
	};
	const filters = filterFor[featureType];
	if (!filters) throw new Error(`No Overpass filter defined for feature_type=${featureType}`);
	const stanzas = filters.map((f) => `  ${f}(${b});`).join("\n");
	return `[out:json][timeout:25];\n(\n${stanzas}\n);\nout tags geom;`;
}

// ============================================================================
// DB-touching layer
// ============================================================================

/** How recent a coverage row needs to be before we re-fetch the area.
 *  6 months is conservative — OSM features for stations and major
 *  roads change slowly. New venues are the main churn but they get
 *  picked up the first time the user queries near them after the TTL
 *  expires. */
const COVERAGE_FRESH_DAYS = 180;

/** Read all coverage rows for one feature_type. Cheap (~tens of rows
 *  across a personal user's whole travel history). */
async function readCoverage(featureType: string): Promise<CoverageRow[]> {
	const rows = await db()
		.selectFrom("osm_coverage")
		.select(["min_lat", "max_lat", "min_lon", "max_lon", "fetched_at"])
		.where("feature_type", "=", featureType)
		.execute();
	return rows.map((r) => ({
		min_lat: Number(r.min_lat),
		max_lat: Number(r.max_lat),
		min_lon: Number(r.min_lon),
		max_lon: Number(r.max_lon),
		fetched_at: r.fetched_at,
	}));
}

/** Run an Overpass fetch for one feature_type over a bbox, parse the
 *  response, upsert features, and record the coverage row. Caller is
 *  responsible for deciding when to call this — see `ensureCovered`. */
async function fetchAndStore(
	featureType: string,
	bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
): Promise<void> {
	const t0 = Date.now();
	const query = buildOverpassQuery(featureType, bbox);
	const res = await overpassFetch(query);
	const fetchMs = Date.now() - t0;
	if (!res.ok) {
		console.warn(`osm-local fetch for ${featureType} bbox ${JSON.stringify(bbox)} returned ${res.status}`);
		return;
	}
	const data = (await res.json()) as { elements?: OverpassElement[] };
	const elements = data.elements ?? [];

	const features: ParsedFeature[] = [];
	for (const el of elements) {
		const parsed = parseOverpassElement(el);
		if (parsed) features.push(parsed);
	}
	// Split by geometry type — points and lines live in separate
	// tables so MariaDB's POINT-POINT-only ST_Distance_Sphere never
	// gets called on a LINESTRING. Each row goes to one table based
	// on its WKT prefix.
	const points = features.filter((f) => f.geom_wkt.startsWith("POINT("));
	const lines = features.filter((f) => f.geom_wkt.startsWith("LINESTRING("));
	await upsertFeatures("osm_points", points);
	await upsertFeatures("osm_lines", lines);

	await db()
		.insertInto("osm_coverage")
		.values({
			min_lat: bbox.minLat,
			max_lat: bbox.maxLat,
			min_lon: bbox.minLon,
			max_lon: bbox.maxLon,
			feature_type: featureType,
		})
		.execute();

	const totalMs = Date.now() - t0;
	console.log(
		`osm-local fetched ${featureType} bbox=${bbox.minLat.toFixed(3)},${bbox.minLon.toFixed(3)}→${bbox.maxLat.toFixed(3)},${bbox.maxLon.toFixed(3)} elements=${elements.length} points=${points.length} lines=${lines.length} fetch=${fetchMs}ms total=${totalMs}ms`,
	);
}

/** Bulk-upsert a batch of features into one of the geometry tables.
 *  Kysely doesn't expose `ST_GeomFromText` so we build the VALUES
 *  list with raw SQL fragments. */
async function upsertFeatures(table: "osm_points" | "osm_lines", features: ParsedFeature[]): Promise<void> {
	if (features.length === 0) return;
	const BATCH = 500;
	for (let i = 0; i < features.length; i += BATCH) {
		const slice = features.slice(i, i + BATCH);
		const valuesList = slice
			.map(
				(f) =>
					sql`(${f.osm_id}, ${f.osm_type}, ${f.feature_type}, ${f.subtype}, ${f.name}, ${JSON.stringify(f.tags)}, ST_GeomFromText(${f.geom_wkt}, 4326))`,
			)
			.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`));
		await sql`
			INSERT INTO ${sql.raw(table)} (osm_id, osm_type, feature_type, subtype, name, tags_json, geom)
			VALUES ${valuesList}
			ON DUPLICATE KEY UPDATE
				subtype = VALUES(subtype),
				name = VALUES(name),
				tags_json = VALUES(tags_json),
				geom = VALUES(geom)
		`.execute(db());
	}
}

/**
 * Ensure the area within `radiusM` of (lat, lon) is covered by a
 * stored coverage box for the given feature_type. If it isn't,
 * fetches a 10 km box around the query and stores it.
 *
 * Stale coverage (older than `COVERAGE_FRESH_DAYS`) is treated as
 * uncovered and re-fetched lazily on next query.
 */
/** In-flight fetch dedup, keyed by `featureType + bbox`. Multiple
 *  ensureCovered callers for the same featureType + bbox share one
 *  fetch instead of each firing their own. Without this, the
 *  velocity pipeline processes many segments in parallel and each
 *  segment's first-bucket lookup independently triggers an Overpass
 *  call → memory pressure + thundering herd. */
const inFlightFetches = new Map<string, Promise<void>>();

export async function ensureCovered(lat: number, lon: number, radiusM: number, featureType: string): Promise<void> {
	const coverage = await readCoverage(featureType);
	const cutoffMs = Date.now() - COVERAGE_FRESH_DAYS * 86400_000;
	const fresh = coverage.filter((c) => !c.fetched_at || c.fetched_at.getTime() > cutoffMs);
	if (isPointCovered(lat, lon, radiusM, fresh)) return;
	const bbox = fetchBboxAround(lat, lon);

	// Dedup: key includes the bbox so distant lookups in the same
	// featureType don't block each other. The bbox is determined by
	// the centre point + fixed half-width, so two callers near the
	// same point produce the same key.
	const key = `${featureType}:${bbox.minLat.toFixed(3)},${bbox.minLon.toFixed(3)}`;
	const existing = inFlightFetches.get(key);
	if (existing) {
		try {
			await existing;
		} catch {
			/* outer handler already logged */
		}
		return;
	}

	const promise = fetchAndStore(featureType, bbox).finally(() => inFlightFetches.delete(key));
	inFlightFetches.set(key, promise);

	// Soft-fail the fetch: if Overpass times out or rejects, log and
	// continue. The query against local osm_points/osm_lines will then
	// just return whatever's already there (often empty for this new
	// area). Matches the negative-cache behaviour of the old withCache
	// path. A later request retries because we didn't record a
	// coverage row.
	try {
		await promise;
	} catch (e) {
		console.warn(`ensureCovered ${featureType} fetch failed at ${lat.toFixed(4)},${lon.toFixed(4)}:`, e);
	}
}

export interface LocalFeatureResult {
	osm_id: number;
	osm_type: string;
	subtype: string | null;
	name: string | null;
	distance_m: number;
	tags: Record<string, string>;
}

/**
 * Run a POINT spatial query against `osm_points`. Returns matches
 * within `radiusM` (great-circle metres) ordered by distance,
 * optionally filtered by an allow-list of subtype values. Used for
 * station-like queries — anywhere we want the closest physical
 * point of interest.
 */
export async function queryPoints(
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
	subtypes?: string[],
): Promise<LocalFeatureResult[]> {
	const point = sql`ST_GeomFromText(${`POINT(${lon} ${lat})`}, 4326)`;
	let q = db()
		.selectFrom("osm_points")
		.select([
			"osm_id",
			"osm_type",
			"subtype",
			"name",
			"tags_json",
			sql<number>`ST_Distance_Sphere(geom, ${point})`.as("distance_m"),
		])
		.where("feature_type", "=", featureType)
		.where(sql<boolean>`ST_Distance_Sphere(geom, ${point}) < ${radiusM}`);
	if (subtypes && subtypes.length > 0) {
		q = q.where("subtype", "in", subtypes);
	}
	const rows = await q
		.orderBy("distance_m" as never)
		.limit(50)
		.execute();
	return rows.map((r) => ({
		osm_id: Number(r.osm_id),
		osm_type: r.osm_type,
		subtype: r.subtype,
		name: r.name,
		distance_m: Number(r.distance_m),
		// MariaDB's JSON column type may return either a string (legacy
		// driver) or a parsed object (driver auto-parses). Handle both.
		tags: (r.tags_json ? (typeof r.tags_json === "string" ? JSON.parse(r.tags_json) : r.tags_json) : {}) as Record<
			string,
			string
		>,
	}));
}

/**
 * Run a LINESTRING spatial query against `osm_lines`. MariaDB's
 * `ST_Distance_Sphere` is POINT-POINT only, so for line distance we
 * use `ST_Distance` (planar, in degrees) with a degree-to-metre
 * conversion in JS. The error is sub-percent at city-scale
 * distances, which is the only regime we use these distances for.
 *
 * Used by `nearbyWays` (roads, rail lines, waterways) and
 * `linesAtPoint` (rail line names within radius).
 */
export async function queryLines(
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
	subtypes?: string[],
): Promise<LocalFeatureResult[]> {
	const point = sql`ST_GeomFromText(${`POINT(${lon} ${lat})`}, 4326)`;
	// Convert radius-metres to a degree budget for the SQL filter.
	// We use the smaller of the two scale factors so the degree
	// circle fully contains the metre circle. Conversion back to
	// metres uses the same scale.
	const mPerDeg = Math.min(METERS_PER_DEG_LAT, metersPerDegLon(lat));
	const dDeg = radiusM / mPerDeg;
	let q = db()
		.selectFrom("osm_lines")
		.select([
			"osm_id",
			"osm_type",
			"subtype",
			"name",
			"tags_json",
			sql<number>`ST_Distance(geom, ${point})`.as("distance_deg"),
		])
		.where("feature_type", "=", featureType)
		.where(sql<boolean>`ST_Distance(geom, ${point}) < ${dDeg}`);
	if (subtypes && subtypes.length > 0) {
		q = q.where("subtype", "in", subtypes);
	}
	const rows = await q
		.orderBy("distance_deg" as never)
		.limit(50)
		.execute();
	return rows.map((r) => ({
		osm_id: Number(r.osm_id),
		osm_type: r.osm_type,
		subtype: r.subtype,
		name: r.name,
		distance_m: Number(r.distance_deg) * mPerDeg,
		// MariaDB's JSON column type may return either a string (legacy
		// driver) or a parsed object (driver auto-parses). Handle both.
		tags: (r.tags_json ? (typeof r.tags_json === "string" ? JSON.parse(r.tags_json) : r.tags_json) : {}) as Record<
			string,
			string
		>,
	}));
}
