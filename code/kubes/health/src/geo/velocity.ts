/**
 * Velocity pipeline: raw PhoneTrack GPS → Kalman filter → segment classification → OSM enrichment.
 *
 * Used by both the API route and the CLI tool.
 */

import { sql } from "kysely";
import { db } from "../db/pool.js";
import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";
import {
	type BiometricEnrichment,
	enrichSegmentWithBiometrics,
	type HrPoint,
	type SleepStageRecord,
} from "./biometrics.js";
import { localSolarHour } from "./focus-places.js";
import type { FilteredPoint } from "./kalman.js";
import { filterGpsTrack } from "./kalman.js";
import { bestPlace, commonCity, extractCity, nearbyWays, placeLabel, refineMode, reverseGeocode } from "./osm.js";
import { type KnownPlace, snapToPlace } from "./place-snap.js";
import type { TrackSegment } from "./segments.js";
import { classifySegments } from "./segments.js";
import { dateBoundsUtc, fitbitTsToUnix } from "./timezone.js";

/**
 * Load Fitbit HR + sleep stages for a UTC time window. Both queries hit a
 * date-string column, so we filter loosely (one-day padding) and trim by
 * unix timestamp after parsing. Both return empty arrays gracefully when
 * the user wasn't wearing their Fitbit (battery, charger, off-arm).
 */
async function loadBiometrics(
	userId: string,
	startUtc: number,
	endUtc: number,
	tz: string | undefined,
): Promise<{ hr: HrPoint[]; sleep: SleepStageRecord[] }> {
	// Pad date-string filter by one day on each side to catch tz-edge timestamps
	const padDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
	const dayBefore = padDate(startUtc - 86400);
	const dayAfter = padDate(endUtc + 86400);

	// Per-minute aggregate. Fitbit stores 1-second-resolution HR (~21k rows
	// per day); for segment-level mean/std the per-minute average loses
	// essentially no precision and is ~60× cheaper to load + parse.
	// Type-safe: table + WHERE columns checked at compile time. The
	// aggregate expressions are unavoidably raw SQL via `sql\`...\`` —
	// no query-builder does GROUP BY DATE_FORMAT cleanly.
	const hrRows = await db()
		.selectFrom("heart_rate_intraday")
		.select([sql<Date>`DATE_FORMAT(MIN(ts), '%Y-%m-%d %H:%i:00')`.as("ts"), sql<number>`ROUND(AVG(bpm))`.as("bpm")])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.groupBy(sql`DATE_FORMAT(ts, '%Y-%m-%d %H:%i')`)
		.orderBy("ts")
		.execute();

	const hr: HrPoint[] = [];
	for (const r of hrRows) {
		const ts = fitbitTsToUnix(r.ts, tz);
		if (Number.isNaN(ts)) continue;
		if (ts < startUtc || ts > endUtc) continue;
		hr.push({ ts, bpm: Number(r.bpm) });
	}

	const sleepRows = await db()
		.selectFrom("sleep_stages")
		.select(["ts", "stage", "duration_seconds"])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.execute();

	const sleep: SleepStageRecord[] = [];
	for (const r of sleepRows) {
		const startTs = fitbitTsToUnix(r.ts, tz);
		if (Number.isNaN(startTs)) continue;
		const endTs = startTs + r.duration_seconds;
		if (endTs < startUtc || startTs > endUtc) continue;
		sleep.push({ startTs, endTs, stage: r.stage });
	}

	return { hr, sleep };
}

/** Returns true if the segment includes ≥1 hour of local overnight time
 *  (00:00–06:00 in the segment's local solar time). Used to decide whether
 *  to prefer a residential address over a nearby amenity at the same coords. */
function hasOvernightPresence(startTs: number, endTs: number, lon: number): boolean {
	const stepSec = 30 * 60;
	let overnight = 0;
	for (let t = startTs; t <= endTs; t += stepSec) {
		const h = localSolarHour(t, lon);
		if (h >= 0 && h < 6) overnight += stepSec / 3600;
	}
	return overnight >= 1;
}

interface NamedPlace extends KnownPlace {
	displayName: string | null;
	sleepHours: number;
}

/** A focus_place is "residential" if the user has slept (covered deep-night
 *  hours) at it for at least RESIDENCE_SLEEP_THRESHOLD_H total hours. */
const RESIDENCE_SLEEP_THRESHOLD_H = 5;

async function loadKnownPlaces(userId: string): Promise<NamedPlace[]> {
	const rows = await db()
		.selectFrom("focus_places")
		.select(["id", "centroid_lat", "centroid_lon", "radius_m", "display_name", "sleep_hours"])
		.where("user_id", "=", userId)
		.execute();
	return rows.map((r) => ({
		id: r.id,
		centroidLat: Number(r.centroid_lat),
		centroidLon: Number(r.centroid_lon),
		radiusM: r.radius_m,
		displayName: r.display_name,
		sleepHours: r.sleep_hours ?? 0,
	}));
}

export interface EnrichedSegment extends TrackSegment {
	place?: string; // human-readable place name (for stationary segments)
	city?: string; // city/town/village (for stationary segments) — frontend groups consecutive same-city segments
	wayName?: string; // road/rail name (for moving segments)
	refinedMode?: string; // OSM-refined transport mode (may differ from heuristic mode)
	refinedReason?: string;
	biometrics?: BiometricEnrichment;
}

export interface VelocityResult {
	points: FilteredPoint[];
	segments: EnrichedSegment[];
}

export async function computeVelocity(
	config: NextcloudConfig,
	userId: string,
	date: string,
	tz?: string,
	options: { enrich?: boolean } = {},
): Promise<VelocityResult> {
	const t0 = Date.now();
	const phaseTimes: Record<string, number> = {};
	const time = <T>(phase: string, p: Promise<T>): Promise<T> => {
		const start = Date.now();
		return p.finally(() => {
			phaseTimes[phase] = (phaseTimes[phase] ?? 0) + (Date.now() - start);
		});
	};
	const timeSync = <T>(phase: string, fn: () => T): T => {
		const start = Date.now();
		try {
			return fn();
		} finally {
			phaseTimes[phase] = (phaseTimes[phase] ?? 0) + (Date.now() - start);
		}
	};

	const nextDay = (() => {
		const d = new Date(date);
		d.setDate(d.getDate() + 1);
		return d.toISOString().slice(0, 10);
	})();

	const bounds = dateBoundsUtc(date, tz);
	const raw = await time("phonetrack", fetchTrackPoints(config, userId, date, nextDay));
	const inDay = raw.filter((p) => p.ts >= bounds.startUtc && p.ts < bounds.endUtc);

	// Place-snap: if a fix is unambiguously close to a known cluster (home,
	// work, etc.), pull it to the cluster centroid. Reduces GPS noise around
	// well-known locations and stabilises both segment timing and labels.
	const knownPlaces = await time("loadPlaces", loadKnownPlaces(userId));
	const snapped =
		knownPlaces.length > 0
			? inDay.map((p) => {
					const r = snapToPlace({ lat: p.lat, lon: p.lon, accuracy: p.accuracy }, knownPlaces);
					return r.snapped ? { ...p, lat: r.lat, lon: r.lon, accuracy: r.accuracy } : p;
				})
			: inDay;

	// Tight filter (≤50m) for movement classification — Kalman-quality data only.
	const gpsPoints = snapped
		.filter((p) => p.accuracy === null || p.accuracy <= 50)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));

	// Loose filter (≤200m) for stay detection — indoor GPS often degrades
	// well past 50m but is still good enough to know you were "around here".
	const stayPoints = snapped
		.filter((p) => p.accuracy === null || p.accuracy <= 200)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon }));

	const points = timeSync("kalman", () => filterGpsTrack(gpsPoints));
	const segments = timeSync("segments", () => classifySegments(points, stayPoints));

	if (options.enrich === false) {
		return { points, segments };
	}

	const N_SAMPLES = 5;

	// Enrich each segment with OSM data
	const enrichStart = Date.now();
	const enriched: EnrichedSegment[] = await Promise.all(
		segments.map(async (seg) => {
			const segPoints = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
			if (segPoints.length === 0) return seg;

			try {
				if (seg.mode === "stationary") {
					let cLat = segPoints.reduce((s, p) => s + p.lat, 0) / segPoints.length;
					let cLon = segPoints.reduce((s, p) => s + p.lon, 0) / segPoints.length;

					// Stay-centroid snap: long stays accumulate centroid drift past the
					// per-fix snap radius. Re-snap the segment centroid against known
					// places with a generous radius so we recover from overnight drift.
					let snappedTo: NamedPlace | null = null;
					if (knownPlaces.length > 0) {
						const r = snapToPlace({ lat: cLat, lon: cLon, accuracy: 200 }, knownPlaces, {
							snapRadiusM: 100,
							minAccuracyToSnapM: 0,
						});
						if (r.snapped) {
							cLat = r.lat;
							cLon = r.lon;
							snappedTo = (knownPlaces.find((p) => p.id === r.snappedTo?.id) as NamedPlace) ?? null;
							// Only Home and Work are personal labels worth showing directly;
							// "Stay" is a category, not a useful timeline label, so for Stay
							// we let bestPlace return the residential address instead.
							if (snappedTo?.displayName === "Home" || snappedTo?.displayName === "Work") {
								// Still call bestPlace (cache hit) so we can attach a city
								// for timeline grouping — keep the personal label.
								const namedPlace = await bestPlace(cLat, cLon, { preferResidential: true });
								const namedCity = extractCity(namedPlace);
								return {
									...seg,
									place: snappedTo.displayName,
									...(namedCity ? { city: namedCity } : {}),
								};
							}
						}
					}

					// "Is this a residential place?" — if the snapped focus_place has
					// significant deep-night history, the cluster is residential and
					// every stay there gets the address label, not the closest amenity.
					// Falls back to per-stay overnight check for unsnapped centroids.
					const preferResidential =
						(snappedTo !== null && snappedTo.sleepHours >= RESIDENCE_SLEEP_THRESHOLD_H) ||
						hasOvernightPresence(seg.startTs, seg.endTs, cLon);
					const place = await bestPlace(cLat, cLon, { preferResidential });
					if (!place) return seg;
					const city = extractCity(place);
					return {
						...seg,
						place: placeLabel(place),
						...(city ? { city } : {}),
					};
				}
				// Moving segment: sample several points along the path so the
				// OSM evidence reflects the whole route, not whatever the
				// centroid happens to land on.
				const sampleCount = Math.min(N_SAMPLES, segPoints.length);
				const sampleIdxs = Array.from({ length: sampleCount }, (_, i) =>
					Math.floor((i * (segPoints.length - 1)) / Math.max(1, sampleCount - 1)),
				);
				const movingStart = segPoints[0];
				const movingEnd = segPoints[segPoints.length - 1];
				const [wayResults, startPlace, endPlace] = await Promise.all([
					Promise.all(sampleIdxs.map((i) => nearbyWays(segPoints[i].lat, segPoints[i].lon))),
					// Endpoint reverseGeocode: tag the segment with a city iff
					// both endpoints agree. A walk inside one city gets a city
					// header; a drive between two cities stays untagged.
					reverseGeocode(movingStart.lat, movingStart.lon),
					reverseGeocode(movingEnd.lat, movingEnd.lon),
				]);
				const seen = new Set<string>();
				const aggregated = [];
				for (const ways of wayResults) {
					for (const w of ways) {
						const key = `${w.type}/${w.subtype}/${w.name ?? ""}`;
						if (!seen.has(key)) {
							seen.add(key);
							aggregated.push(w);
						}
					}
				}
				const refined = refineMode(seg.mode, seg.avgSpeed, aggregated);
				const movingCity = commonCity(startPlace, endPlace);
				return {
					...seg,
					refinedMode: refined.mode,
					refinedReason: refined.reason,
					wayName: refined.wayName,
					...(movingCity ? { city: movingCity } : {}),
				};
			} catch (e) {
				console.warn(`OSM enrichment failed for segment ${seg.startTs}: ${e}`);
				return seg;
			}
		}),
	);
	phaseTimes.osm = Date.now() - enrichStart;

	const merged = timeSync("merge", () => mergeAdjacentMoving(mergeAdjacentStays(enriched)));

	// Cross-modal enrichment: attach HR / sleep stats per segment when the
	// data is available. Missing Fitbit data → biometrics is just left null.
	const { hr, sleep } = await time(
		"biomLoad",
		loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz).catch((e: unknown) => {
			// Don't fail the whole request — biometrics are an enrichment.
			// But log the error so a broken Fitbit feed (or DB issue) doesn't
			// hide behind silently-empty HR + sleep arrays.
			console.warn(`loadBiometrics failed for user=${userId} date=${date}: ${e}`);
			return { hr: [] as HrPoint[], sleep: [] as SleepStageRecord[] };
		}),
	);
	const withBiometrics = timeSync("biomEnrich", () =>
		merged.map((s) => ({ ...s, biometrics: enrichSegmentWithBiometrics(s, hr, sleep) })),
	);

	const total = Date.now() - t0;
	const summary = Object.entries(phaseTimes)
		.map(([k, v]) => `${k}=${v}ms`)
		.join(" ");
	console.log(`velocity ${date} user=${userId}: total=${total}ms ${summary} segments=${withBiometrics.length}`);

	return { points, segments: withBiometrics };
}

/**
 * Merge two consecutive stationary segments that resolved to the same `place`
 * label and are separated by ≤ 5 min. Reflects the user's intent: a brief
 * pause that lands inside the same venue should read as one stay, not two.
 *
 * Chains (A, A, A) collapse into one. We deliberately do NOT collapse across
 * a real movement segment yet — keeps the post-step trivially correct.
 */
export function mergeAdjacentStays(segments: EnrichedSegment[]): EnrichedSegment[] {
	const result: EnrichedSegment[] = [];
	for (const seg of segments) {
		const prev = result[result.length - 1];
		if (
			prev &&
			prev.mode === "stationary" &&
			seg.mode === "stationary" &&
			prev.place &&
			prev.place === seg.place &&
			seg.startTs - prev.endTs <= 5 * 60
		) {
			prev.endTs = seg.endTs;
			prev.pointCount += seg.pointCount;
		} else {
			result.push({ ...seg });
		}
	}
	return result;
}

/**
 * Merge consecutive moving segments that share a refined mode and are
 * separated by a small gap. Mirrors `mergeAdjacentStays` for the moving
 * case: the segment classifier oscillates between similar modes
 * (driving ↔ train) on long highway runs and `refineMode` corrects each
 * label individually but leaves the boundaries in place. This collapses
 * those now-redundant boundaries.
 *
 * Stationary segments are left untouched — that's `mergeAdjacentStays`'
 * job and the predicate there (same `place`) is stricter.
 *
 * A different mode in the middle (e.g. a brief walking break for
 * dropping someone off) breaks the chain — that pause is exactly what
 * the user wants to see.
 */
const MOVING_MERGE_MAX_GAP_S = 3 * 60;

/**
 * Pick a wayName label for a merged moving segment. Each source segment
 * contributes its `wayName` weighted by its duration; we sort by time,
 * drop names under WAY_LABEL_MIN_COVERAGE of the total, and emit up to
 * WAY_LABEL_MAX_NAMES names joined by ", " — but stop early if the
 * joined string exceeds WAY_LABEL_MAX_CHARS so the timeline UI stays
 * tidy. The result is always at most one short line of text.
 */
const WAY_LABEL_MAX_CHARS = 30;
const WAY_LABEL_MIN_COVERAGE = 0.15;
const WAY_LABEL_MAX_NAMES = 3;

export function composeWayName(contribs: Map<string, number>): string | null {
	let total = 0;
	for (const v of contribs.values()) total += v;
	if (total === 0) return null;
	const ranked = [...contribs.entries()]
		.sort((a, b) => b[1] - a[1])
		.filter(([, dur]) => dur / total >= WAY_LABEL_MIN_COVERAGE)
		.slice(0, WAY_LABEL_MAX_NAMES)
		.map(([name]) => name);
	if (ranked.length === 0) return null;
	let label = ranked[0];
	for (let i = 1; i < ranked.length; i++) {
		const tentative = `${label}, ${ranked[i]}`;
		if (tentative.length > WAY_LABEL_MAX_CHARS) break;
		label = tentative;
	}
	return label;
}

export function mergeAdjacentMoving(segments: EnrichedSegment[]): EnrichedSegment[] {
	const modeOf = (s: EnrichedSegment): string => s.refinedMode ?? s.mode;
	const result: EnrichedSegment[] = [];
	const wayContribs = new WeakMap<EnrichedSegment, Map<string, number>>();
	const addContribution = (target: EnrichedSegment, name: string | undefined, durationS: number): void => {
		if (!name || durationS <= 0) return;
		let m = wayContribs.get(target);
		if (!m) {
			m = new Map();
			wayContribs.set(target, m);
		}
		m.set(name, (m.get(name) ?? 0) + durationS);
	};

	for (const seg of segments) {
		const prev = result[result.length - 1];
		const segMode = modeOf(seg);
		const segDuration = seg.endTs - seg.startTs;
		if (
			prev &&
			segMode !== "stationary" &&
			modeOf(prev) === segMode &&
			seg.startTs - prev.endTs <= MOVING_MERGE_MAX_GAP_S &&
			// Don't merge across a city boundary. Both undefined (typical
			// transit) is fine; a defined city followed by transit (or two
			// different cities) means the user crossed a boundary mid-trip
			// and the city signal is worth preserving.
			prev.city === seg.city
		) {
			const w0 = prev.pointCount;
			const w1 = seg.pointCount;
			const wTot = w0 + w1;
			prev.endTs = seg.endTs;
			prev.pointCount = wTot;
			prev.avgSpeed = Math.round(((prev.avgSpeed * w0 + seg.avgSpeed * w1) / wTot) * 10) / 10;
			prev.maxSpeed = Math.round(Math.max(prev.maxSpeed, seg.maxSpeed) * 10) / 10;
			prev.linearity = Math.round(((prev.linearity * w0 + seg.linearity * w1) / wTot) * 100) / 100;
			prev.confidence = Math.round(((prev.confidence * w0 + seg.confidence * w1) / wTot) * 100) / 100;
			addContribution(prev, seg.wayName, segDuration);
		} else {
			const copy = { ...seg };
			result.push(copy);
			addContribution(copy, seg.wayName, segDuration);
		}
	}

	// Resolve composite wayName from per-segment contributions. A single
	// contributor short-circuits to the existing wayName; multiple sources
	// produce a time-ordered, coverage-filtered, char-budgeted label.
	for (const seg of result) {
		const contribs = wayContribs.get(seg);
		if (!contribs) continue;
		const composite = composeWayName(contribs);
		if (composite) seg.wayName = composite;
	}

	return result;
}
