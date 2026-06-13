/**
 * refresh-bus-routes — mirror OSM `route=bus` relations into
 * `bus_route_cache`.
 *
 * # Why this exists
 *
 * Naming the bus a road-vehicle leg rode (C-bus, the "bus 38" case) needs
 * the route NETWORK: each route's ordered stop list, so a leg that boards
 * near one stop and alights near a later one can be anchored to the route
 * (`bus-route-match.ts`). Fetching that from Overpass is far too heavy for
 * the dashboard request path, so it is mirrored offline, here, into
 * `bus_route_cache` and read back with a single indexed scan.
 *
 * A route's stop sequence is stable, so it is keyed by relation, reused
 * across every day the route appears. The whole table is rebuilt
 * transactionally each run — a pure cache, fully recomputable, no
 * incremental accumulator (the same discipline as refresh-rail-routes).
 *
 * # Scope discipline (the throttling lesson)
 *
 * The bbox is the bounding box of the user's focus places, not all of
 * London — only routes the user could plausibly ride are mirrored. The
 * single Overpass call goes through the shared circuit breaker, and the
 * bbox is hard-capped: a degenerate, country-spanning focus set would
 * otherwise pull tens of thousands of routes. This is the discipline
 * `osm_way_routes` lacked the first time (see `rail-snap.md`).
 *
 * Run by the data-analysis cron (and manually):
 *   node dist/cli/refresh-bus-routes.js
 */

import { z } from "zod";
import { db, destroyPool, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { serializeBusRoute } from "../geo/bus-route-cache.js";
import { buildBusRouteOverpassQuery, extractBusRoutes } from "../geo/osm-bus-routes.js";
import { overpassFetch } from "../geo/osm-overpass.js";
import { type Bbox, bboxFromFixes } from "../geo/route-graph-loader.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
	})
	.parse({
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
	});

/** Hard cap on the mirror bbox span (degrees ≈ 55 km/°). A focus set
 *  spanning more than this is travel history across cities, not a single
 *  metropolitan area — refuse rather than pull a continent of bus routes. */
const MAX_BBOX_SPAN_DEG = 0.7;

initPool(config.db);
await withConnection(migrate);

/** Bounding box over every user's focus places, padded. The mirror is
 *  global (not user-scoped), so one bbox covers everyone's home area. */
async function focusPlacesBbox(): Promise<Bbox | null> {
	const places = await db().selectFrom("focus_places").select(["centroid_lat", "centroid_lon"]).execute();
	const fixes = places.map((p) => ({ lat: Number(p.centroid_lat), lon: Number(p.centroid_lon) }));
	return bboxFromFixes(fixes, 1500);
}

const bbox = await focusPlacesBbox();
if (!bbox) {
	console.log("No focus places — nothing to mirror.");
	await destroyPool();
	process.exit(0);
}

const latSpan = bbox.maxLat - bbox.minLat;
const lonSpan = bbox.maxLon - bbox.minLon;
if (latSpan > MAX_BBOX_SPAN_DEG || lonSpan > MAX_BBOX_SPAN_DEG) {
	console.error(
		`Refusing to mirror: focus-place bbox spans ${latSpan.toFixed(2)}°×${lonSpan.toFixed(2)}° (cap ${MAX_BBOX_SPAN_DEG}°). ` +
			"Focus places span multiple regions; tile the mirror before widening.",
	);
	await destroyPool();
	process.exit(1);
}

console.log(
	`Mirroring route=bus relations in bbox ${bbox.minLat.toFixed(3)},${bbox.minLon.toFixed(3)}→${bbox.maxLat.toFixed(3)},${bbox.maxLon.toFixed(3)}`,
);

const t0 = Date.now();
const res = await overpassFetch(buildBusRouteOverpassQuery(bbox));
if (!res.ok) {
	console.error(`Overpass returned ${res.status} — leaving bus_route_cache untouched.`);
	await destroyPool();
	process.exit(1);
}

// The relation⇄member-node join needs the whole element set together, so
// this reads the full response (bounded by the capped bbox) rather than
// streaming chunk-by-chunk, which would split relations from their nodes.
const data = (await res.json()) as Parameters<typeof extractBusRoutes>[0];
const routes = extractBusRoutes(data);
console.log(`Parsed ${routes.length} bus routes (${Date.now() - t0}ms)`);

await withConnection(async (conn) => {
	// Transactional full rebuild — readers see the old snapshot until
	// commit, so the dashboard never observes an empty cache mid-refresh.
	await conn.beginTransaction();
	try {
		await conn.query("DELETE FROM bus_route_cache");
		if (routes.length > 0) {
			const rows = routes.map((r) => {
				const s = serializeBusRoute(r);
				return [s.osm_relation_id, s.route_ref, s.route_name, s.stops_json];
			});
			await conn.batch(
				"INSERT INTO bus_route_cache (osm_relation_id, route_ref, route_name, stops_json) VALUES (?, ?, ?, ?)",
				rows,
			);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	}
});
console.log(`bus_route_cache rebuilt: ${routes.length} routes`);

await destroyPool();
process.exit(0);
