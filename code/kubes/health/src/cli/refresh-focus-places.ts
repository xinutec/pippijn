/**
 * Rebuild the focus_places table for one (or all) users by fetching the
 * user's last LOOKBACK_DAYS of PhoneTrack history and running the focus-
 * places pipeline. Replaces the user's rows in focus_places inside a
 * transaction so the dashboard never sees an empty snapshot mid-refresh.
 *
 * Run manually for now (will become a weekly cron once stable):
 *   node dist/cli/refresh-focus-places.js              # all users with NC linked
 *   node dist/cli/refresh-focus-places.js <user_id>    # one user, default 365d
 *   node dist/cli/refresh-focus-places.js <user_id> 90 # one user, explicit days
 */

import tzLookup from "tz-lookup";
import { z } from "zod";
import { db, destroyPool, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { setSyncState } from "../db/sync-state.js";
import {
	assignDisplayNames,
	type Cluster,
	classifyCluster,
	detectFocusPlaces,
	type FitbitSleepWindow,
	type RawPoint,
	sleepHoursFromFitbit,
	sleepHoursOf,
	uniqueDayCount,
} from "../geo/focus-places.js";
import { bestPlace, type NearbyLandmark, nearbyLandmarks } from "../geo/osm.js";
import {
	amenityLabelFor,
	type ClusterStat,
	kindPrior,
	mineDwellModel,
	nameCluster,
	nearestVenueKind,
} from "../geo/place-naming.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../nextcloud/phonetrack.js";

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

const DEFAULT_LOOKBACK_DAYS = 365;
const FETCH_CHUNK_DAYS = 7;

const argUserId = process.argv[2] ?? null;
const argLookbackDays = Number.parseInt(process.argv[3] ?? "", 10) || DEFAULT_LOOKBACK_DAYS;

initPool(config.db);
await withConnection(migrate);

function ymdNDaysAgo(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
}

async function fetchAllPoints(userId: string, daysBack: number): Promise<RawPoint[]> {
	// Build the Nextcloud client + sessions list once and reuse across all
	// chunks — used to be one DB lookup + one client construction + one
	// sessions-list call per chunk (~26× for the default 180-day backfill).
	const ctx = await openPhoneTrack(config, userId);
	const all: RawPoint[] = [];
	const seen = new Set<string>();
	for (let offset = daysBack; offset > 0; offset -= FETCH_CHUNK_DAYS) {
		const start = ymdNDaysAgo(offset);
		const end = ymdNDaysAgo(Math.max(0, offset - FETCH_CHUNK_DAYS));
		const points = await fetchTrackPointsRange(ctx, start, end);
		for (const p of points) {
			const k = `${p.ts}/${p.lat.toFixed(6)}/${p.lon.toFixed(6)}`;
			if (seen.has(k)) continue;
			seen.add(k);
			all.push({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy });
		}
	}
	all.sort((a, b) => a.ts - b.ts);
	return all;
}

async function refreshOne(userId: string): Promise<void> {
	const t0 = Date.now();
	const points = await fetchAllPoints(userId, argLookbackDays);
	const fetchMs = Date.now() - t0;
	if (points.length === 0) {
		console.log(`[${userId}] no PhoneTrack history in last ${argLookbackDays}d, skipping`);
		return;
	}

	const t1 = Date.now();
	const result = detectFocusPlaces(points);
	console.log(
		`[${userId}] ${points.length} points (fetch ${fetchMs}ms) → ${result.stays.length} stays → ${result.clusters.length} clusters (${Date.now() - t1}ms)`,
	);

	// Load Fitbit sleep windows covering the same lookback period so
	// `sleepHoursFromFitbit` can compute per-cluster actual-sleep hours
	// instead of the local-clock 02:00–06:00 heuristic. Falls back to
	// the old heuristic for users without Fitbit data.
	const sleepRows = await db()
		.selectFrom("sleep")
		.select(["start_time", "end_time"])
		.where("user_id", "=", userId)
		.where("is_main_sleep", "=", true)
		.execute();
	const fitbitSleepWindows: FitbitSleepWindow[] = sleepRows.map((r) => ({
		startTs: Math.floor(new Date(r.start_time).getTime() / 1000),
		endTs: Math.floor(new Date(r.end_time).getTime() / 1000),
	}));
	const hasFitbitSleep = fitbitSleepWindows.length > 0;
	console.log(`[${userId}] loaded ${fitbitSleepWindows.length} Fitbit sleep windows for mining`);

	// Name each cluster by scoring every nearby OSM venue by its distance
	// to the cluster's accuracy-weighted centroid, the user's propensity
	// for that kind of venue, and how well this cluster's per-visit dwell
	// fits that kind — see geo/place-naming.ts. A confident pick is
	// stored as the venue name; an ambiguous one is hedged
	// "winner / runner-up" so the timeline shows the real uncertainty.
	//
	// Skip clusters that look residential (Fitbit-confirmed sleep_hours
	// above the threshold): the runtime labeller uses the OSM
	// residential-address lookup for those, and `amenity_label` would be
	// dead data that an old code path could mis-pick up.
	const RESIDENCE_SLEEP_THRESHOLD_H = 5;
	const tMine = Date.now();
	const amenityLabels = new Map<number, string | null>();

	// Pass 1 — fetch each non-residential cluster's OSM venue candidates,
	// and record a stat (provisional kind, dwell, per-visit length) that
	// feeds the mined behavioural models.
	const candidatesByCluster = new Map<number, { landmarks: NearbyLandmark[]; visitLengthSec: number }>();
	const stats: ClusterStat[] = [];
	for (const c of result.clusters) {
		const clusterSleepH = hasFitbitSleep ? sleepHoursFromFitbit(c.stays, fitbitSleepWindows) : sleepHoursOf(c);
		if (clusterSleepH >= RESIDENCE_SLEEP_THRESHOLD_H) {
			amenityLabels.set(c.id, null);
			continue;
		}
		const landmarks = await nearbyLandmarks(c.centroidLat, c.centroidLon);
		const visitLengthSec = c.totalDwellSec / c.stays.length;
		candidatesByCluster.set(c.id, { landmarks, visitLengthSec });
		const kind = nearestVenueKind(landmarks);
		if (kind !== null) stats.push({ kind, totalDwellSec: c.totalDwellSec, visitLengthSec });
	}

	// The user's behavioural models, mined from their own clusters:
	// P(kind) — how their out-of-home time splits across venue kinds —
	// and P(dwell | kind) — how long a visit to each kind tends to last.
	const prior = kindPrior(stats);
	const dwellModel = mineDwellModel(stats);

	// Pass 2 — name each cluster against those models.
	for (const [id, { landmarks, visitLengthSec }] of candidatesByCluster) {
		amenityLabels.set(id, amenityLabelFor(nameCluster(landmarks, prior, dwellModel, visitLengthSec)));
	}
	console.log(
		`[${userId}] amenity mining: ${[...amenityLabels.values()].filter((v) => v !== null).length}/${
			result.clusters.length
		} clusters labelled (${Date.now() - tMine}ms)`,
	);

	await withConnection(async (conn) => {
		await conn.beginTransaction();
		try {
			await conn.query("DELETE FROM focus_places WHERE user_id = ?", [userId]);
			if (result.clusters.length > 0) {
				const displayNames = assignDisplayNames(result.clusters);
				const rows = result.clusters.map((c) => {
					const sortedStays = [...c.stays].sort((a, b) => a.startTs - b.startTs);
					const cls = classifyCluster(c);
					// Prefer Fitbit-confirmed sleep hours when available;
					// fall back to the local-clock 02-06 heuristic for
					// users without Fitbit data.
					const sleepH = hasFitbitSleep ? sleepHoursFromFitbit(c.stays, fitbitSleepWindows) : sleepHoursOf(c);
					return [
						userId,
						c.centroidLat,
						c.centroidLon,
						25,
						c.totalDwellSec,
						c.stays.length,
						uniqueDayCount(c.stays, c.centroidLon),
						sortedStays[0].startTs,
						sortedStays[sortedStays.length - 1].endTs,
						cls.label,
						displayNames.get(c.id) ?? null,
						Math.round(sleepH),
						amenityLabels.get(c.id) ?? null,
					];
				});
				await conn.batch(
					"INSERT INTO focus_places (user_id, centroid_lat, centroid_lon, radius_m, total_dwell_sec, visit_count, unique_days, first_seen_ts, last_seen_ts, detected_label, display_name, sleep_hours, amenity_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					rows,
				);

				// Identify the Home cluster (if any) and write the residence tz
				// to sync_state for use as a fallback at read time. Passing `conn`
				// makes this part of the transaction — a half-failed refresh
				// rolls back the home_tz update along with the focus_places rows.
				// If no Home cluster qualifies this run, leave sync_state.home_tz
				// untouched (don't clobber a previously-good value).
				for (const c of result.clusters) {
					if (displayNames.get(c.id) === "Home") {
						const homeTz = tzLookup(c.centroidLat, c.centroidLon);
						await setSyncState(userId, "home_tz", homeTz, conn);
						console.log(`[${userId}] home_tz = ${homeTz}`);
						break;
					}
				}
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback();
			throw e;
		}
	});
	console.log(`[${userId}] focus_places refreshed (${result.clusters.length} rows)`);

	// Proactive OSM cache warming: pre-fetch the place name + nearby
	// landmarks for each focus_place's centroid. Live dashboard requests
	// then hit the cache, and we snapshot the OSM data while connectivity
	// is good — so a future Overpass outage doesn't blank labels for
	// places we already know about. Failures are non-fatal (negative cache
	// will TTL out and we'll try again on the next refresh).
	await warmOsmCache(result.clusters);
}

async function warmOsmCache(clusters: Cluster[]): Promise<void> {
	const ordered = [...clusters].sort((a, b) => b.totalDwellSec - a.totalDwellSec);
	let warmed = 0;
	let failed = 0;
	for (const c of ordered) {
		try {
			await Promise.all([
				bestPlace(c.centroidLat, c.centroidLon, { preferResidential: true }),
				nearbyLandmarks(c.centroidLat, c.centroidLon, 100),
			]);
			warmed++;
		} catch {
			failed++;
		}
	}
	console.log(`Warmed OSM cache for ${warmed} focus_places (${failed} failed)`);
}

if (argUserId) {
	await refreshOne(argUserId);
} else {
	const users = await db().selectFrom("nc_tokens").select("user_id").execute();
	if (users.length === 0) {
		console.log("No users with Nextcloud linked.");
	}
	for (const u of users) {
		try {
			await refreshOne(u.user_id);
		} catch (e) {
			console.error(`[${u.user_id}] refresh failed:`, e);
		}
	}
}

await destroyPool();
process.exit(0);
