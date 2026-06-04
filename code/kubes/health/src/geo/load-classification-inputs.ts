/**
 * Production loader for `ClassificationInputs`.
 *
 * Phase 1 of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * Mirrors the eager-fetch path currently inlined at the top of
 * `computeVelocity`. Production wraps the classification pipeline by
 * calling `loadClassificationInputs` then `computeVelocity(inputs)`
 * (Phase 2 — refactor not yet applied). Tests load from a captured
 * fixture instead.
 *
 * Phase 1 covers only the eager loads. The lazy ones (OSM mirror,
 * decoded_days, rail_route_cache, presence_log) keep being fetched
 * from the DB inside the pipeline until their own phase migrates
 * them onto the inputs value. The `ClassificationInputs` type
 * evolves additively.
 *
 * No behaviour change: this file's queries are byte-for-byte the
 * same projections used inside `velocity.ts` today. Verified during
 * Phase 2 by running the existing golden suite — zero diff is the
 * acceptance criterion.
 */

import { sql } from "kysely";
import { db } from "../db/pool.js";
import { loadDecode } from "../hmm/persist.js";
import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../nextcloud/phonetrack.js";
import type {
	ClassificationInputs,
	DayIdentity,
	KnownPlaceProjection,
	RawPhonetrackFix,
} from "./classification-inputs.js";
import { parseHourProfile } from "./focus-places.js";
import type { ModeStats } from "./mode-biometrics.js";
import { ensureCovered, parseLineStringWkt, parsePointWkt } from "./osm-local.js";
import type { OsmSnapshot, OsmSnapshotLine, OsmSnapshotPoint } from "./osm-pure.js";
import { haversineMeters } from "./place-snap.js";
import { dateBoundsUtc } from "./timezone.js";
import { loadBiometrics } from "./velocity.js";

/** Load the full `ClassificationInputs` closure for one day from the
 *  production data sources. The Promise resolves to a serialisable
 *  value the pipeline can consume; nothing in the value holds a DB
 *  handle. */
export async function loadClassificationInputs(
	config: NextcloudConfig,
	identity: DayIdentity,
): Promise<ClassificationInputs> {
	const { userId, date, displayTz } = identity;
	const bounds = dateBoundsUtc(date, displayTz);

	// Same day-string arithmetic as velocity.ts — UTC-midnight parse,
	// ±1 day, ISO date slice. Keeps the three PhoneTrack window
	// boundaries identical to the inlined version.
	const nextDay = shiftDay(date, +1);
	const prevDay = shiftDay(date, -1);
	const nextDayMorningEnd = `${nextDay}T12:00:00Z`;
	const prevDayEveningStart = `${prevDay}T12:00:00Z`;

	// PhoneTrack: open once, three parallel range fetches. Mirrors the
	// pattern at velocity.ts:537-544 — three windows off one session
	// context, same call shape.
	const phoneTrackCtx = await openPhoneTrack(config, userId);
	const [today, morning, priorEvening] = await Promise.all([
		fetchTrackPointsRange(phoneTrackCtx, date, nextDay),
		fetchTrackPointsRange(phoneTrackCtx, nextDay, nextDayMorningEnd),
		fetchTrackPointsRange(phoneTrackCtx, prevDayEveningStart, date),
	]);

	// Eager DB reads in parallel — known places, mode biometrics, and
	// the per-day biometric streams. The biometric loader does its own
	// three parallel queries (HR / sleep / steps), so we await the
	// composite. Failure on biometrics is non-fatal: prod has missing-
	// Fitbit days and the pipeline tolerates empty arrays. Mirrors the
	// `.catch` previously inlined inside `computeVelocity`.
	const [knownPlaces, modeBiometrics, biometrics, hsmmDecode, railRouteCache, osm] = await Promise.all([
		loadKnownPlacesQuery(userId),
		loadModeBiometricsQuery(userId),
		loadBiometrics(userId, bounds.startUtc, bounds.endUtc, displayTz).catch((e: unknown) => {
			console.warn(`loadBiometrics failed for user=${userId} date=${date}: ${e}`);
			return { hr: [], sleep: [], steps: [] };
		}),
		loadDecode(db(), userId, date),
		loadRailRouteCacheQuery(),
		// Phase 6b plumbs the OSM snapshot through the type system but
		// keeps the loader as an empty-set no-op. The eager bbox-scale
		// load was triggering large Overpass fetches on cold-miss
		// travel days, making the prod path ~6× slower (verified
		// 2026-06-04 against the golden suite). The pure helpers in
		// `osm-pure.ts` are ready; Phase 6c will gate the full load
		// behind an `opts.loadOsm` flag and migrate callers in
		// velocity.ts one at a time, only triggering the snapshot
		// load when a caller actually consumes `inputs.osm`.
		Promise.resolve<OsmSnapshot>({ lines: [], points: [] }),
	]);

	return {
		identity,
		phonetrack: {
			today: today as RawPhonetrackFix[],
			morning: morning as RawPhonetrackFix[],
			priorEvening: priorEvening as RawPhonetrackFix[],
		},
		knownPlaces,
		biometrics,
		modeBiometrics,
		hsmmDecode,
		railRouteCache,
		osm,
	};
}

/** Pre-load the entire `rail_route_cache`. The table is global (not
 *  user-scoped) and small — a few hundred rows of polyline JSON in
 *  total, easily under 1 MB. `annotateSnappedPaths` does an in-memory
 *  `Map` lookup on what's loaded; routes the day doesn't use are
 *  simply ignored, no extra cost beyond the eager load. */
async function loadRailRouteCacheQuery(): Promise<Array<{ routeKey: string; geometryJson: string }>> {
	const rows = await db().selectFrom("rail_route_cache").select(["route_key", "geometry_json"]).execute();
	return rows.map((r) => ({ routeKey: r.route_key, geometryJson: r.geometry_json }));
}

/** Feature types the pipeline queries. Loader fetches all of them so
 *  every `nearbyWays`/`nearbyStations`-equivalent call at request
 *  time can be served from the in-memory snapshot. */
const OSM_FEATURE_TYPES = ["highway", "railway", "waterway", "aeroway", "landmark"] as const;

/** Per-call radius the existing `nearbyWays`/`nearbyStations` use,
 *  plus a buffer for Kalman drift. Used as a snapshot-area padding
 *  so a query at any post-Kalman lat/lon inside the PhoneTrack bbox
 *  still finds the rows it would have found via the DB-backed
 *  per-call path. */
const SNAPSHOT_BUFFER_M = 1_000;

/** Build the OSM snapshot for the day. Computes a single bbox over
 *  all three PhoneTrack windows, ensures the local mirror covers
 *  it, then loads every line and point row for the feature types
 *  the pipeline reads. The hot path (Phase 6d migration) becomes a
 *  pure filter over the in-memory snapshot.
 *
 *  Returns an empty snapshot when there are no fixes at all (no
 *  bbox to query). */
async function loadOsmSnapshotForDay(
	today: ReadonlyArray<{ lat: number; lon: number }>,
	morning: ReadonlyArray<{ lat: number; lon: number }>,
	priorEvening: ReadonlyArray<{ lat: number; lon: number }>,
): Promise<OsmSnapshot> {
	const allFixes = [...today, ...morning, ...priorEvening];
	if (allFixes.length === 0) return { lines: [], points: [] };

	let minLat = allFixes[0].lat;
	let maxLat = allFixes[0].lat;
	let minLon = allFixes[0].lon;
	let maxLon = allFixes[0].lon;
	for (const f of allFixes) {
		if (f.lat < minLat) minLat = f.lat;
		if (f.lat > maxLat) maxLat = f.lat;
		if (f.lon < minLon) minLon = f.lon;
		if (f.lon > maxLon) maxLon = f.lon;
	}
	const centerLat = (minLat + maxLat) / 2;
	const centerLon = (minLon + maxLon) / 2;
	const diagonalM = haversineMeters(minLat, minLon, maxLat, maxLon);
	const radiusM = diagonalM / 2 + SNAPSHOT_BUFFER_M;

	// Mirror coverage: same per-feature-type ensureCovered the
	// per-call nearbyWays/nearbyStations already do, just at the
	// day's bbox scale. Serial (not Promise.all) — each Overpass
	// response can be 5–50 MB in dense urban bboxes and four-at-once
	// has OOM'd a 256 MB pod (see osm.ts:824).
	for (const t of OSM_FEATURE_TYPES) {
		await ensureCovered(centerLat, centerLon, radiusM, t);
	}

	// Query all rows in the area, with raw geometry.
	const [lines, points] = await Promise.all([
		Promise.all(OSM_FEATURE_TYPES.map((t) => loadOsmLinesWithGeom(centerLat, centerLon, radiusM, t))),
		Promise.all(OSM_FEATURE_TYPES.map((t) => loadOsmPointsWithGeom(centerLat, centerLon, radiusM, t))),
	]);
	return {
		lines: lines.flat(),
		points: points.flat(),
	};
}

/** Spatial query against `osm_lines` returning the row + parsed
 *  geometry, for snapshot construction. Same MBR+ST_Distance filter
 *  pattern as `buildLinesQuery` in `osm-local.ts`. */
async function loadOsmLinesWithGeom(
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
): Promise<OsmSnapshotLine[]> {
	const M_PER_DEG_LAT = 111_000;
	const mPerDeg = Math.min(M_PER_DEG_LAT, M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
	const dDeg = radiusM / mPerDeg;
	const point = sql`ST_GeomFromText(${`POINT(${lon} ${lat})`}, 4326)`;
	const rows = await db()
		.selectFrom("osm_lines")
		.select(["subtype", "name", sql<string>`ST_AsText(geom)`.as("geom_wkt")])
		.where("feature_type", "=", featureType)
		.where(sql<boolean>`MBRIntersects(geom, ST_Buffer(${point}, ${dDeg}))`)
		.where(sql<boolean>`ST_Distance(geom, ${point}) < ${dDeg}`)
		.execute();
	const out: OsmSnapshotLine[] = [];
	for (const r of rows) {
		const geom = parseLineStringWkt(r.geom_wkt);
		if (geom.length < 2) continue;
		out.push({ featureType, subtype: r.subtype, name: r.name, geometry: geom });
	}
	return out;
}

/** Spatial query against `osm_points` returning the row + parsed
 *  geometry + tags. Same MBR pattern. */
async function loadOsmPointsWithGeom(
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
): Promise<OsmSnapshotPoint[]> {
	const M_PER_DEG_LAT = 111_000;
	const mPerDeg = Math.min(M_PER_DEG_LAT, M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
	const dDeg = radiusM / mPerDeg;
	const point = sql`ST_GeomFromText(${`POINT(${lon} ${lat})`}, 4326)`;
	const rows = await db()
		.selectFrom("osm_points")
		.select(["subtype", "name", "tags_json", sql<string>`ST_AsText(geom)`.as("geom_wkt")])
		.where("feature_type", "=", featureType)
		.where(sql<boolean>`MBRIntersects(geom, ST_Buffer(${point}, ${dDeg}))`)
		.where(sql<boolean>`ST_Distance_Sphere(geom, ${point}) < ${radiusM}`)
		.execute();
	const out: OsmSnapshotPoint[] = [];
	for (const r of rows) {
		const parsed = parsePointWkt(r.geom_wkt);
		if (parsed === null) continue;
		const tags = r.tags_json
			? typeof r.tags_json === "string"
				? (JSON.parse(r.tags_json) as Record<string, string>)
				: (r.tags_json as Record<string, string>)
			: {};
		out.push({ featureType, subtype: r.subtype, name: r.name, lat: parsed.lat, lon: parsed.lon, tags });
	}
	return out;
}

function shiftDay(date: string, days: number): string {
	const d = new Date(date);
	d.setDate(d.getDate() + days);
	return d.toISOString().slice(0, 10);
}

/** focus_places projection used by `snapToPlace` + the place picker.
 *  Same SELECT columns and same row mapping as `loadKnownPlaces`
 *  inside `velocity.ts`. Phase 2 will collapse the duplication by
 *  removing the inline copy. */
async function loadKnownPlacesQuery(userId: string): Promise<KnownPlaceProjection[]> {
	const rows = await db()
		.selectFrom("focus_places")
		.select([
			"id",
			"centroid_lat",
			"centroid_lon",
			"radius_m",
			"display_name",
			"sleep_hours",
			"amenity_label",
			"unique_days",
			"hour_profile",
		])
		.where("user_id", "=", userId)
		.execute();
	return rows.map((r) => ({
		id: r.id,
		centroidLat: Number(r.centroid_lat),
		centroidLon: Number(r.centroid_lon),
		radiusM: r.radius_m,
		displayName: r.display_name,
		sleepHours: r.sleep_hours ?? 0,
		amenityLabel: r.amenity_label,
		uniqueDays: r.unique_days,
		hourProfile: parseHourProfile(r.hour_profile),
	}));
}

/** mode_biometrics projection — per-user per-mode biometric
 *  signatures. Same SELECT and row mapping as `loadModeBiometrics`
 *  inside `velocity.ts`. */
async function loadModeBiometricsQuery(userId: string): Promise<ModeStats[]> {
	const rows = await db().selectFrom("mode_biometrics").selectAll().where("user_id", "=", userId).execute();
	return rows.map((r) => ({
		mode: r.mode,
		hrMean: r.hr_mean !== null ? Number(r.hr_mean) : null,
		hrStd: r.hr_std !== null ? Number(r.hr_std) : null,
		hrSampleCount: r.hr_sample_count,
		cadenceMean: r.cadence_mean !== null ? Number(r.cadence_mean) : null,
		cadenceStd: r.cadence_std !== null ? Number(r.cadence_std) : null,
		cadenceSampleCount: r.cadence_sample_count,
		speedMean: r.speed_mean !== null ? Number(r.speed_mean) : null,
		speedStd: r.speed_std !== null ? Number(r.speed_std) : null,
		speedSampleCount: r.speed_sample_count,
		sampleCount: r.sample_count,
	}));
}
