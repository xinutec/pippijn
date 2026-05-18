/**
 * refresh-rail-routes — precompute snapped rail-track geometry.
 *
 * # Why this exists
 *
 * The rail-snap feature draws a train journey on the OSM rail track
 * instead of the raw GPS zigzag. Computing that geometry means a heavy
 * spatial scan of the ~1M-row osm_lines mirror — far too slow to run on
 * the dashboard request path.
 *
 * So it is computed offline, here. For every distinct train route in a
 * recent window of days this resolves the route's snapped geometry and
 * stores it in `rail_route_cache`, keyed by the run's
 * `<board> → <alight>` station-pair label. The velocity pipeline then
 * attaches the geometry to a train segment with a single indexed
 * lookup (see `annotateSnappedPaths`).
 *
 * A rail route's drawn geometry is the same every time it is travelled,
 * so it is keyed by route, not by day — the work is reused across every
 * day that route appears. The whole table is rebuilt transactionally
 * each run: a pure cache, fully recomputable, no incremental
 * accumulator.
 *
 * Run by the data-analysis cron (and manually):
 *   node dist/cli/refresh-rail-routes.js        # default 180-day window
 *   node dist/cli/refresh-rail-routes.js 90     # explicit window
 */

import { z } from "zod";
import { db, destroyPool, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { getSyncState } from "../db/sync-state.js";
import { queryRailCorridor } from "../geo/osm-local.js";
import { snapTrainSegment } from "../geo/rail-snap.js";
import { computeVelocity } from "../geo/velocity.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
		nextcloud: z.object({
			baseUrl: z.string().url().default("https://dash.xinutec.org"),
			clientId: z.string().min(1),
			clientSecret: z.string().min(1),
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
		nextcloud: {
			baseUrl: process.env.NC_BASE_URL,
			clientId: process.env.NC_CLIENT_ID,
			clientSecret: process.env.NC_CLIENT_SECRET,
		},
	});

/**
 * Days back to scan. Deliberately short.
 *
 * Each day is processed by `computeVelocity`, whose classification
 * lazily fetches OSM geometry for any area not yet in the local mirror.
 * Recent days are in already-travelled, already-covered areas, so they
 * are cheap; reaching months back hits old trips to uncovered cities,
 * and a single dense-city Overpass fetch can take 10+ minutes. A short
 * window keeps the nightly job to a few minutes and still catches every
 * regularly-travelled route (a commute recurs well within three weeks).
 * Tunable via argv — but widening it past recent history reintroduces
 * the OSM-backfill cost.
 */
const DEFAULT_WINDOW_DAYS = 21;
const windowDays = Number.parseInt(process.argv[2] ?? "", 10) || DEFAULT_WINDOW_DAYS;

initPool(config.db);
await withConnection(migrate);

function ymdNDaysAgo(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
}

type Geometry = Array<{ lat: number; lon: number }>;

/**
 * Walk a user's window day by day, newest first, and compute the
 * snapped geometry of every distinct train route. First success for a
 * route wins (newest instance — freshest OSM); routes that fail to snap
 * are retried on older days. Results are accumulated into `routes`.
 */
async function collectUserRoutes(userId: string, tz: string, routes: Map<string, Geometry>): Promise<void> {
	for (let offset = 0; offset <= windowDays; offset++) {
		const date = ymdNDaysAgo(offset);
		let result: Awaited<ReturnType<typeof computeVelocity>>;
		try {
			result = await computeVelocity(config, userId, date, tz);
		} catch (e) {
			console.warn(`[${userId} ${date}] computeVelocity failed:`, e);
			continue;
		}
		for (const seg of result.segments) {
			if ((seg.refinedMode ?? seg.mode) !== "train" || !seg.wayName) continue;
			if (routes.has(seg.wayName)) continue; // route already resolved this run
			const fixes = result.points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
			if (fixes.length === 0) continue;
			const geo = await queryRailCorridor(fixes);
			const snapped = snapTrainSegment({ startTs: seg.startTs, endTs: seg.endTs, wayName: seg.wayName }, geo);
			if (snapped) {
				routes.set(
					seg.wayName,
					snapped.path.map((p) => ({ lat: p.lat, lon: p.lon })),
				);
				console.log(`  resolved route → ${snapped.path.length} pts (from ${date})`);
			}
		}
	}
}

const users = await db().selectFrom("nc_tokens").select("user_id").execute();
if (users.length === 0) {
	console.log("No users with Nextcloud linked.");
}

const routes = new Map<string, Geometry>();
for (const u of users) {
	const tz = (await getSyncState(u.user_id, "home_tz")) ?? "Europe/London";
	console.log(`[${u.user_id}] scanning ${windowDays}-day window (tz=${tz})`);
	try {
		await collectUserRoutes(u.user_id, tz, routes);
	} catch (e) {
		console.error(`[${u.user_id}] route scan failed:`, e);
	}
}

console.log(`Computed ${routes.size} route geometries; rebuilding rail_route_cache`);
await withConnection(async (conn) => {
	// Transactional full rebuild — readers see the old snapshot until
	// commit, so the dashboard never observes an empty cache mid-refresh.
	await conn.beginTransaction();
	try {
		await conn.query("DELETE FROM rail_route_cache");
		if (routes.size > 0) {
			const rows = [...routes.entries()].map(([key, geom]) => [key, JSON.stringify(geom)]);
			await conn.batch("INSERT INTO rail_route_cache (route_key, geometry_json) VALUES (?, ?)", rows);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	}
});
console.log(`rail_route_cache rebuilt: ${routes.size} routes`);

await destroyPool();
process.exit(0);
