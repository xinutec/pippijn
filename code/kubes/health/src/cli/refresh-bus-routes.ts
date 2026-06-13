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
import type { BusRoute } from "../geo/bus-route-match.js";
import { buildBusRouteOverpassQuery, extractBusRoutes } from "../geo/osm-bus-routes.js";
import { overpassFetch } from "../geo/osm-overpass.js";
import { type Bbox, bboxFromFixes, tileBbox } from "../geo/route-graph-loader.js";

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

// A single whole-bbox `relation[route=bus]` query over greater London
// matches ~700 routes and pulls every member node of each — far too big
// for one Overpass fetch (it timed out on first run). Tile the bbox into
// small cells and union the routes across cells (deduped by relation id):
// each cell matches only the routes touching it, so each query is light.
// `node(r)` still returns each matched route's FULL stop list, so a route
// is mirrored end-to-end even when only its middle crosses a cell.
const MIRROR_TILE_DEG = 0.05; // ≈ 3.5 km — keeps each cell's route set small.
const TILE_TIMEOUT_MS = 90_000; // offline budget, well above the 20s request-path cap.
const tiles = tileBbox(bbox, MIRROR_TILE_DEG);
console.log(
	`Mirroring route=bus relations across ${tiles.length} tiles of bbox ${bbox.minLat.toFixed(3)},${bbox.minLon.toFixed(3)}→${bbox.maxLat.toFixed(3)},${bbox.maxLon.toFixed(3)}`,
);

const t0 = Date.now();
const byRelation = new Map<number, BusRoute>();
let tileFailures = 0;
for (const [i, tile] of tiles.entries()) {
	try {
		const res = await overpassFetch(buildBusRouteOverpassQuery(tile), { timeoutMs: TILE_TIMEOUT_MS });
		if (!res.ok) {
			console.warn(`  tile ${i + 1}/${tiles.length}: Overpass ${res.status} — skipped`);
			tileFailures++;
			continue;
		}
		const data = (await res.json()) as Parameters<typeof extractBusRoutes>[0];
		const routes = extractBusRoutes(data);
		for (const r of routes) byRelation.set(r.osmRelationId, r);
		console.log(`  tile ${i + 1}/${tiles.length}: ${routes.length} routes (${byRelation.size} unique so far)`);
	} catch (e) {
		console.warn(`  tile ${i + 1}/${tiles.length}: ${e instanceof Error ? e.message : String(e)} — skipped`);
		tileFailures++;
	}
}

// Refuse to clobber a populated cache with a near-empty rebuild when the
// fetches broadly failed (Overpass down / breaker open) — a partial mirror
// is fine, but an all-failed run must not wipe yesterday's good data.
if (byRelation.size === 0 && tileFailures > 0) {
	console.error(`All ${tiles.length} tiles failed — leaving bus_route_cache untouched.`);
	await destroyPool();
	process.exit(1);
}

const routes = [...byRelation.values()];
console.log(`Parsed ${routes.length} unique bus routes from ${tiles.length} tiles (${Date.now() - t0}ms)`);

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
