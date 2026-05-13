/**
 * Velocity pipeline: raw PhoneTrack GPS → Kalman filter → segment classification → OSM enrichment.
 *
 * Used by both the API route and the CLI tool.
 */

import { sql } from "kysely";
import tzLookup from "tz-lookup";
import { db } from "../db/pool.js";
import { getSyncState } from "../db/sync-state.js";
import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";
import {
	type BiometricEnrichment,
	correctModeFromCadence,
	enrichSegmentWithBiometrics,
	type HrPoint,
	type SleepStageRecord,
	type StepPoint,
} from "./biometrics.js";
import { localSolarHour } from "./focus-places.js";
import type { FilteredPoint } from "./kalman.js";
import { filterGpsTrack } from "./kalman.js";
import { correctModeBySignature, type ModeStats } from "./mode-biometrics.js";
import {
	bestPlace,
	commonCity,
	extractCity,
	linesAtPoint,
	type NearbyStation,
	nearbyStations,
	nearbyWays,
	pickBestStation,
	placeLabel,
	refineMode,
	reverseGeocode,
} from "./osm.js";
import { haversineMeters, type KnownPlace, snapToPlace } from "./place-snap.js";
import type { TrackSegment } from "./segments.js";
import { classifySegments, enforcePhysicalConstraints } from "./segments.js";
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
): Promise<{ hr: HrPoint[]; sleep: SleepStageRecord[]; steps: StepPoint[] }> {
	// Pad date-string filter by one day on each side to catch tz-edge timestamps
	const padDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
	const dayBefore = padDate(startUtc - 86400);
	const dayAfter = padDate(endUtc + 86400);

	// Per-row tz fallback chain: row.tz → home_tz → request tz. The request
	// tz only applies to rows where the recording tz couldn't be inferred
	// (legacy NULL rows from before Phase 1+2 deploy, or rows in a sync
	// run where both PhoneTrack and profile.tz were unavailable).
	// See TIMEZONE.md for the full design.
	const homeTz = await getSyncState(userId, "home_tz");
	const resolveTz = (rowTz: string | null): string | undefined => rowTz ?? homeTz ?? tz;

	// Per-minute aggregate. Fitbit stores 1-second-resolution HR (~21k rows
	// per day); for segment-level mean/std the per-minute average loses
	// essentially no precision and is ~60× cheaper to load + parse.
	// MAX(tz): all rows in a per-minute bucket share the same wall-clock-
	// formatted minute, and a tz change moves wall-clock discontinuously,
	// so a single bucket cannot contain rows recorded under two tzs.
	// MAX gives a deterministic "the bucket's tz" picking arbitrarily.
	const hrRows = await db()
		.selectFrom("heart_rate_intraday")
		.select([
			sql<Date>`DATE_FORMAT(MIN(ts), '%Y-%m-%d %H:%i:00')`.as("ts"),
			sql<number>`ROUND(AVG(bpm))`.as("bpm"),
			sql<string | null>`MAX(tz)`.as("tz"),
		])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.groupBy(sql`DATE_FORMAT(ts, '%Y-%m-%d %H:%i')`)
		.orderBy("ts")
		.execute();

	const hr: HrPoint[] = [];
	for (const r of hrRows) {
		const ts = fitbitTsToUnix(r.ts, resolveTz(r.tz));
		if (Number.isNaN(ts)) continue;
		if (ts < startUtc || ts > endUtc) continue;
		hr.push({ ts, bpm: Number(r.bpm) });
	}

	const sleepRows = await db()
		.selectFrom("sleep_stages")
		.select(["ts", "stage", "duration_seconds", "tz"])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.execute();

	const sleep: SleepStageRecord[] = [];
	for (const r of sleepRows) {
		const startTs = fitbitTsToUnix(r.ts, resolveTz(r.tz));
		if (Number.isNaN(startTs)) continue;
		const endTs = startTs + r.duration_seconds;
		if (endTs < startUtc || startTs > endUtc) continue;
		sleep.push({ startTs, endTs, stage: r.stage });
	}

	// Steps intraday — only non-zero minutes are stored, so the row count
	// directly reflects "user took at least one step in this minute".
	const stepRows = await db()
		.selectFrom("steps_intraday")
		.select(["ts", "steps", "tz"])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.execute();

	const steps: StepPoint[] = [];
	for (const r of stepRows) {
		const ts = fitbitTsToUnix(r.ts, resolveTz(r.tz));
		if (Number.isNaN(ts)) continue;
		if (ts < startUtc || ts > endUtc) continue;
		steps.push({ ts, steps: r.steps });
	}

	return { hr, sleep, steps };
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
	amenityLabel: string | null;
}

/** A focus_place is "residential" if the user has slept (covered deep-night
 *  hours) at it for at least RESIDENCE_SLEEP_THRESHOLD_H total hours. */
const RESIDENCE_SLEEP_THRESHOLD_H = 5;

/**
 * Decide whether to label a stationary segment with its cluster's mined
 * `amenity_label` (Bairro Alto, Wasabi, etc.) instead of going through the
 * one-shot OSM picker. Pure function so the gate is testable independent of
 * the I/O-heavy enrichment pipeline.
 *
 * Returns true iff all of:
 *   - the segment snapped to a cluster (snappedTo non-null)
 *   - the cluster has a mined amenity_label
 *   - the cluster is NOT residential (sleepHours < threshold) — residential
 *     clusters are lodging, so the closest amenity is wrong even on daytime
 *     visits. Fitbit's overnight presence is the constraint.
 *   - the cluster is not Home/Work, which has its own labelling branch
 *     upstream and shouldn't be reached here in practice (defensive).
 */
export function shouldUseClusterAmenity(
	snappedTo: { displayName: string | null; sleepHours: number; amenityLabel: string | null } | null,
	residenceThreshold: number,
): boolean {
	if (!snappedTo) return false;
	if (snappedTo.amenityLabel === null) return false;
	if (snappedTo.displayName === "Home" || snappedTo.displayName === "Work") return false;
	if (snappedTo.sleepHours >= residenceThreshold) return false;
	return true;
}

/** Load the user's mined per-mode biometric signatures. Returns an empty
 *  array for cold-start users (no `mode_biometrics` rows) so callers can
 *  treat absent-data as no-op without special-casing. */
async function loadModeBiometrics(userId: string): Promise<ModeStats[]> {
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

/** Mean of HR / cadence stream values over a segment's time range. */
function meanInWindow<T extends { ts: number }>(
	stream: T[],
	field: (x: T) => number | null,
	startTs: number,
	endTs: number,
): number | null {
	let sum = 0;
	let count = 0;
	for (const s of stream) {
		if (s.ts < startTs || s.ts > endTs) continue;
		const v = field(s);
		if (v === null) continue;
		sum += v;
		count++;
	}
	return count > 0 ? sum / count : null;
}

/** Apply per-user biometric-signature correction to one segment. Inferred-
 *  gap segments are skipped (no observations to score). For others, aggregate
 *  HR + cadence from the loaded biometric streams and run the pure decision
 *  helper. On change, record refinedReason so the timeline shows why. */
function applyBiometricSignature(
	seg: EnrichedSegment,
	hr: HrPoint[],
	steps: StepPoint[],
	modeStats: ModeStats[],
): EnrichedSegment {
	if (seg.refinedReason?.startsWith("inferred from GPS gap")) return seg;
	const obsHr = meanInWindow(hr, (p) => p.bpm, seg.startTs, seg.endTs);
	const obsCadence = meanInWindow(steps, (p) => p.steps, seg.startTs, seg.endTs);
	const obsSpeed = seg.avgSpeed;
	const currentMode = seg.refinedMode ?? seg.mode;
	const r = correctModeBySignature(
		{ mode: currentMode, confidenceMargin: seg.confidenceMargin, obsHr, obsCadence, obsSpeed },
		modeStats,
	);
	if (!r.changed) return seg;
	return {
		...seg,
		refinedMode: r.mode,
		refinedReason: `re-classified as ${r.mode} by biometric signature`,
	};
}

async function loadKnownPlaces(userId: string): Promise<NamedPlace[]> {
	const rows = await db()
		.selectFrom("focus_places")
		.select(["id", "centroid_lat", "centroid_lon", "radius_m", "display_name", "sleep_hours", "amenity_label"])
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
	}));
}

export interface EnrichedSegment extends TrackSegment {
	place?: string; // human-readable place name (for stationary segments)
	city?: string; // city/town/village (for stationary segments) — frontend groups consecutive same-city segments
	wayName?: string; // road/rail name (for moving segments)
	refinedMode?: string; // OSM-refined transport mode (may differ from heuristic mode)
	refinedReason?: string;
	displayTz?: string; // IANA tz to render the segment'\''s timestamps in (frontend uses this instead of browser tz)
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

	// Use the same loose accuracy ceiling (≤200m) for both movement and stay
	// detection. The Kalman filter already weights measurements by their
	// accuracy^2 variance (kalman.ts), so a noisy fix contributes much less
	// to the trajectory estimate than a clean one — pre-filtering at 50m
	// just throws away signal that's especially valuable for high-speed
	// linear travel (trains, planes), where even a 150m fix is a useful
	// anchor along an inherently smooth path.
	const gpsPoints = snapped
		.filter((p) => p.accuracy === null || p.accuracy <= 200)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));

	const stayPoints = snapped
		.filter((p) => p.accuracy === null || p.accuracy <= 200)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon }));

	const points = timeSync("kalman", () => filterGpsTrack(gpsPoints));
	const segments = timeSync("segments", () => classifySegments(points, stayPoints));

	if (options.enrich === false) {
		return { points, segments };
	}

	const N_SAMPLES = 5;

	// Kick off biometrics load in parallel with OSM enrichment — both are
	// I/O-bound, no need to serialise them. The result is needed for cadence-
	// based mode correction (between OSM enrichment and merge) plus the final
	// per-segment enrichment after merge.
	const biometricsPromise = time(
		"biomLoad",
		loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz).catch((e: unknown) => {
			console.warn(`loadBiometrics failed for user=${userId} date=${date}: ${e}`);
			return { hr: [] as HrPoint[], sleep: [] as SleepStageRecord[], steps: [] as StepPoint[] };
		}),
	);

	// Enrich each segment with OSM data
	const enrichStart = Date.now();
	const enriched: EnrichedSegment[] = await Promise.all(
		segments.map(async (seg) => {
			// Inferred-from-gap segments have no real GPS data — enriching them
			// with road names / OSM places would invent context we don't have.
			// Pass them through with their inferred refinedReason intact.
			if (seg.refinedReason?.startsWith("inferred from GPS gap")) return seg;
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
							// Per-cluster amenity label: when refresh-focus-places has
							// majority-voted across the user's visits and produced a
							// confident venue name, prefer that over the per-visit OSM
							// picker — except for residential clusters, where Fitbit's
							// sleep data tells us the user is at lodging, not at the
							// closest cafe. See `shouldUseClusterAmenity`.
							if (shouldUseClusterAmenity(snappedTo, RESIDENCE_SLEEP_THRESHOLD_H) && snappedTo?.amenityLabel) {
								const namedPlace = await bestPlace(cLat, cLon, { preferResidential: false });
								const namedCity = extractCity(namedPlace);
								return {
									...seg,
									place: snappedTo.amenityLabel,
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
				// Dedup by (type, subtype, name) but keep the *minimum* distance
				// across sample points. A road we brushed past at one sample
				// shouldn't outweigh a road we hugged at four others — and the
				// distance is what refineMode uses to tie-break parallel
				// rail/road.
				const byKey = new Map<string, (typeof wayResults)[number][number]>();
				for (const ways of wayResults) {
					for (const w of ways) {
						const key = `${w.type}/${w.subtype}/${w.name ?? ""}`;
						const existing = byKey.get(key);
						if (!existing) {
							byKey.set(key, w);
						} else {
							const existingD = existing.distanceM ?? Number.POSITIVE_INFINITY;
							const newD = w.distanceM ?? Number.POSITIVE_INFINITY;
							if (newD < existingD) byKey.set(key, w);
						}
					}
				}
				const aggregated = [...byKey.values()];
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

	// Cadence-based correction: a "walking" segment with no recorded steps
	// is almost certainly a passenger in slow traffic, an escalator, or
	// similar — relabel before merge so neighbouring drives can absorb it.
	const { hr, sleep, steps } = await biometricsPromise;
	const corrected = timeSync("cadenceCorrect", () => enriched.map((s) => correctModeFromCadence(s, steps)));

	// Biometric-signature correction: re-evaluate ambiguous segments
	// against the user's per-mode (HR, cadence, speed) signatures from
	// mode_biometrics. Fixes the walking-mislabeled-as-driving case
	// (low-speed segment with HR 110 + cadence 100 looks nothing like
	// driving even though the speed scored ambiguously) and the cycling-
	// mislabeled-as-driving case. See `correctModeBySignature` for the
	// gating rules.
	const modeStats = await loadModeBiometrics(userId);
	const biometricCorrected = timeSync("biometricCorrect", () =>
		corrected.map((seg) => applyBiometricSignature(seg, hr, steps, modeStats)),
	);

	// Hard physical-impossibility overrides: a car can't sustain 300+ km/h,
	// a train can't average 600 km/h. These are constraints, not
	// heuristics — enforced regardless of GPS / OSM / biometric output.
	// Apply BEFORE merge so consistent modes can coalesce. Also propagate
	// the override into refinedMode so downstream consumers (annotateRail
	// Runs, frontend) see the corrected mode.
	const physicallyCorrected = timeSync("physicalConstraints", () =>
		biometricCorrected.map((seg) => {
			const corrected = enforcePhysicalConstraints(seg);
			if (corrected.mode === seg.mode) return seg;
			return { ...corrected, refinedMode: corrected.mode };
		}),
	);

	const merged = timeSync("merge", () => mergeAdjacentMoving(mergeAdjacentStays(physicallyCorrected)));

	const withStations = await annotateRailRuns(merged, points);

	// Per-segment displayTz: the IANA tz the frontend should use to render
	// the segment's wall-clock. Derived from the segment's geographic
	// location (centroid for stationary, midpoint for moving). Lets the UI
	// show times "as the user experienced them" — morning at parents in
	// CEST, evening home in BST, even across a travel day. Fallback to
	// home_tz / Europe/Amsterdam when no points cover the segment (inferred
	// gap segments).
	const homeTz = (await getSyncState(userId, "home_tz")) ?? "Europe/Amsterdam";
	const withDisplayTz = timeSync("displayTz", () =>
		withStations.map((s): EnrichedSegment => {
			const segPoints = points.filter((p) => p.ts >= s.startTs && p.ts <= s.endTs);
			if (segPoints.length === 0) {
				return { ...s, displayTz: homeTz };
			}
			// Stationary: centroid. Moving: midpoint of path.
			let lat: number;
			let lon: number;
			if (s.mode === "stationary") {
				lat = segPoints.reduce((acc, p) => acc + p.lat, 0) / segPoints.length;
				lon = segPoints.reduce((acc, p) => acc + p.lon, 0) / segPoints.length;
			} else {
				const mid = segPoints[Math.floor(segPoints.length / 2)];
				lat = mid.lat;
				lon = mid.lon;
			}
			try {
				return { ...s, displayTz: tzLookup(lat, lon) };
			} catch {
				return { ...s, displayTz: homeTz };
			}
		}),
	);

	// Final cross-modal enrichment: attach HR / sleep / steps stats per
	// segment. Missing Fitbit data → biometrics fields are null/zero.
	const withBiometrics = timeSync("biomEnrich", () =>
		withDisplayTz.map((s) => ({ ...s, biometrics: enrichSegmentWithBiometrics(s, hr, sleep, steps) })),
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
		// Strictly conflicting city tags (both defined, different value) block
		// the merge — the user crossed an actual boundary. A defined city
		// next to an untagged transit segment is fine to merge: the merged
		// city falls back to undefined unless all sources agree (handled below).
		const citiesConflict =
			prev !== undefined && prev.city !== undefined && seg.city !== undefined && prev.city !== seg.city;

		if (
			prev &&
			segMode !== "stationary" &&
			modeOf(prev) === segMode &&
			seg.startTs - prev.endTs <= MOVING_MERGE_MAX_GAP_S &&
			!citiesConflict
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
			prev.confidenceMargin = Math.round(((prev.confidenceMargin * w0 + seg.confidenceMargin * w1) / wTot) * 100) / 100;
			// City: only carry forward if all merged sources agree on it.
			// Mismatched (one tagged, the other untagged) → drop, since the
			// merged span no longer corresponds to a single city.
			if (prev.city !== seg.city) prev.city = undefined;
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

/**
 * Annotate consecutive rail-like segments as a single tube/train journey.
 *
 * A "rail-like" segment is anything classified as train (mode or refinedMode)
 * plus inferred-vehicle-speed gaps that look like a tube ride continuation
 * (refinedReason "inferred from GPS gap" with non-stationary mode and
 * avgSpeed >= 7). A maximal run of these is a single journey: a Wembley
 * Park → Kings Cross tube ride that surfaced for one fix mid-route shows
 * up as train + inferred-gap + train (different modes, so mergeAdjacentMoving
 * leaves them separate), but it's one journey and gets one label.
 *
 * Per run, we look up nearby stations at the outer-bounding fixes (last fix
 * at-or-before run start, first fix at-or-after run end) and label every
 * segment in the run with "<board> → <alight>". This fixes the Baker Street
 * false-alight: a noisy mid-ride fix near Baker Street can't produce a
 * "Baker Street" annotation because the run's outer fixes are at the true
 * board/alight platforms.
 */
/** Search radius (m) for rail-run endpoint station lookup. Larger than the
 *  default 200m of nearbyStations because overground stations often have
 *  the first post-train GPS fix 200-300m away — the phone reports the next
 *  position after the user has already walked away from the platform. */
const RAIL_RUN_STATION_RADIUS_M = 400;

/** Speed (km/h) below which we treat a fix as "the user is at or near a
 *  station, not in transit." The first fix at-or-after the rail run's
 *  endTs is often still on the train (surface GPS reading mid-route);
 *  we want the first fix where the user has actually disembarked and is
 *  walking or stopped. Walking pace is ~5 km/h, generous buffer at 15. */
const POST_TRANSIT_SPEED_KMH = 15;

export async function annotateRailRuns(
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]> = (lat, lon) =>
		nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
	linesLookup: (lat: number, lon: number) => Promise<Set<string>> = linesAtPoint,
): Promise<EnrichedSegment[]> {
	const isRailLike = (s: EnrichedSegment): boolean => {
		if (s.mode === "train" || s.refinedMode === "train") return true;
		const inferredVehicleGap =
			s.refinedReason?.startsWith("inferred from GPS gap") && s.mode !== "stationary" && s.avgSpeed >= 7;
		return Boolean(inferredVehicleGap);
	};

	// A short stationary segment bordered by rail-like segments is almost
	// always a train pause (signal stop, station dwell) — the user is on
	// the same train the whole time. Collapse the whole run into one
	// segment so the timeline doesn't show meaningless "Cafe X · 2 min"
	// artefacts in the middle of a tube ride. Threshold deliberately
	// tight (5 min) so that genuine longer stays still surface.
	const TRAIN_PAUSE_MAX_SEC = 5 * 60;
	const couldBeTrainPause = (s: EnrichedSegment): boolean =>
		s.mode === "stationary" && s.endTs - s.startTs <= TRAIN_PAUSE_MAX_SEC;

	// Identify maximal rail runs. A run starts and ends with a rail-like
	// segment but may absorb short stationary "platform" segments in the
	// middle when followed by another rail-like segment. The interior
	// absorbed stationaries get relabelled below.
	const runs: { from: number; toExclusive: number; absorbedStationary: number[] }[] = [];
	for (let i = 0; i < segments.length; ) {
		if (!isRailLike(segments[i])) {
			i++;
			continue;
		}
		let j = i + 1;
		const absorbed: number[] = [];
		while (j < segments.length) {
			if (isRailLike(segments[j])) {
				j++;
				continue;
			}
			// Absorb a short stationary IFF a rail-like segment follows it.
			// Without that follow-up condition we'd swallow the trailing
			// stationary at the end of a journey too (e.g. arriving home).
			if (couldBeTrainPause(segments[j]) && j + 1 < segments.length && isRailLike(segments[j + 1])) {
				absorbed.push(j);
				j += 2; // skip the stationary AND the rail-like that confirmed it
				continue;
			}
			break;
		}
		runs.push({ from: i, toExclusive: j, absorbedStationary: absorbed });
		i = j;
	}

	// Look up board/alight stations and disambiguating line names for each
	// run in parallel. The station lookup and line lookup have independent
	// failure modes — a line-lookup failure (Overpass down, no data) should
	// degrade to a station-pair label, not lose the annotation entirely.
	const runLabels = await Promise.all(
		runs.map(async (run) => {
			const startTs = segments[run.from].startTs;
			const endTs = segments[run.toExclusive - 1].endTs;
			// Prefer fixes where the user is NOT in transit (speed below
			// walking pace) — these are at-or-near a station rather than
			// mid-route. Met line surfaces between Finchley Road and
			// Wembley Park, so the first fix at-or-after the run's endTs
			// can be a real GPS reading at ~30 km/h mid-train. Skipping
			// transit-speed fixes gets us to the actual disembark-and-
			// walk-near-station fix. Fall back to any fix if none qualify.
			const slow = (p: FilteredPoint): boolean => p.speed_kmh < POST_TRANSIT_SPEED_KMH;
			const slowBefore =
				[...points].reverse().find((p) => p.ts <= startTs && slow(p)) ??
				[...points].reverse().find((p) => p.ts <= startTs);
			const after = points.find((p) => p.ts >= endTs && slow(p)) ?? points.find((p) => p.ts >= endTs);
			if (!slowBefore || !after) return null;
			console.log(
				`[rail-run-debug] startTs=${new Date(startTs * 1000).toISOString()} endTs=${new Date(endTs * 1000).toISOString()} slowBefore=(${slowBefore.lat.toFixed(5)},${slowBefore.lon.toFixed(5)})@${new Date(slowBefore.ts * 1000).toISOString()} after=(${after.lat.toFixed(5)},${after.lon.toFixed(5)})@${new Date(after.ts * 1000).toISOString()}`,
			);

			// Boarding-station lookup with preceding-stationary preference,
			// gated by a walking-pace sanity check.
			//
			// Walk back through stationary + walking segments only; stop
			// at any other mode (e.g. a previous train, driving) so we
			// don't claim the last journey's destination as this one's
			// boarding station. The first stationary segment we hit whose
			// location resolves to a real station is a *candidate*.
			//
			// The candidate is used IFF the user's apparent velocity from
			// the stationary endpoint to slowBefore is mid-tunnel-noise
			// territory (> 15 km/h). If it's realistic walking pace, the
			// user genuinely moved to a different station and we should
			// trust slowBefore's lookup — the 2026-05-12 Marylebone case
			// where 1.4 km walked at ~10 km/h ended at a different station
			// from the preceding Stationary at Work.
			let startStation: string | undefined;
			let beforeLookup = { lat: slowBefore.lat, lon: slowBefore.lon };
			let endStation: string | undefined;
			const BOARDING_NOISE_SPEED_KMH = 15;
			try {
				let stationaryCandidate: { name: string; lat: number; lon: number; endTs: number } | null = null;
				for (let i = run.from - 1; i >= 0; i--) {
					const seg = segments[i];
					if (seg.mode === "stationary") {
						const segPoints = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
						if (segPoints.length > 0) {
							const last = segPoints[segPoints.length - 1];
							const stations = await stationsLookup(last.lat, last.lon);
							const best = pickBestStation(stations);
							if (best) {
								stationaryCandidate = { name: best.name, lat: last.lat, lon: last.lon, endTs: last.ts };
							}
						}
						break;
					}
					if (seg.mode !== "walking") break;
				}

				if (stationaryCandidate) {
					const dM = haversineMeters(
						stationaryCandidate.lat,
						stationaryCandidate.lon,
						slowBefore.lat,
						slowBefore.lon,
					);
					const dt = Math.max(1, slowBefore.ts - stationaryCandidate.endTs);
					const apparentKmh = (dM / dt) * 3.6;
					if (apparentKmh > BOARDING_NOISE_SPEED_KMH) {
						// slowBefore is mid-tunnel GPS noise — trust stationary.
						startStation = stationaryCandidate.name;
						beforeLookup = { lat: stationaryCandidate.lat, lon: stationaryCandidate.lon };
					}
					// else: realistic walking pace, fall through to slowBefore.
				}

				const [startStationsSlow, endStations] = await Promise.all([
					startStation ? Promise.resolve([]) : stationsLookup(slowBefore.lat, slowBefore.lon),
					stationsLookup(after.lat, after.lon),
				]);
				if (!startStation) startStation = pickBestStation(startStationsSlow)?.name;
				// Fallback for back-compat: when slowBefore doesn't resolve
				// to a station but a preceding-stationary station exists,
				// use that — covers the original "user noisy at platform"
				// case from before the velocity gate was added.
				if (!startStation && stationaryCandidate) {
					startStation = stationaryCandidate.name;
					beforeLookup = { lat: stationaryCandidate.lat, lon: stationaryCandidate.lon };
				}
				endStation = pickBestStation(endStations)?.name;
			} catch {
				return null;
			}
			if (!startStation || !endStation) return null;
			// Same station at both ends: probably hanging around a single
			// station rather than actually riding. Skip annotation — don't
			// even fetch lines for this run.
			if (startStation === endStation) return null;
			const base = `${startStation} → ${endStation}`;
			// Line intersection: which line serves both physical endpoints?
			// Met/Jubilee both serve Wembley Park but only Met reaches Kings
			// Cross — the intersection is {Met}. Append the suffix only
			// when the intersection is a singleton; on empty (one endpoint
			// off-OSM, or disjoint sets) or ambiguous (>1 line serves both),
			// fall through to the bare station-pair label.
			try {
				const [startLines, endLines] = await Promise.all([
					linesLookup(beforeLookup.lat, beforeLookup.lon),
					linesLookup(after.lat, after.lon),
				]);
				const intersection = [...startLines].filter((l) => endLines.has(l));
				if (intersection.length === 1) return `${base} · ${intersection[0]}`;
				return base;
			} catch {
				return base;
			}
		}),
	);

	// Apply. For each rail run:
	//   - Single-segment run: keep shape, just annotate with the
	//     station-pair label (if available).
	//   - Multi-segment run (with or without absorbed short stationaries):
	//     collapse into one train segment spanning the whole journey.
	//     The user thinks of it as one ride — "I got on at Kings Cross,
	//     off at Wembley Park" — not three sub-windows of the classifier
	//     plus a momentary train pause. Surface the journey, not the
	//     artefacts.
	// Segments outside any run pass through unchanged.
	const out: EnrichedSegment[] = [];
	const runByStart = new Map(runs.map((r, idx) => [r.from, idx]));
	let i = 0;
	while (i < segments.length) {
		const runIdx = runByStart.get(i);
		if (runIdx === undefined) {
			out.push({ ...segments[i] });
			i++;
			continue;
		}
		const run = runs[runIdx];
		const label = runLabels[runIdx];
		if (run.toExclusive - run.from === 1 && run.absorbedStationary.length === 0) {
			// Single-segment rail run. Annotate with the station label
			// AND upgrade the mode to "train" — a station-pair label
			// only gets produced when BOTH endpoints resolve to real
			// stations (line 833), which is strong rail evidence. The
			// classifier may have called this "driving" because the
			// GPS surface fixes look road-shaped (high linearity,
			// vehicle-speed), but the station-pair annotation outranks
			// that. Without the upgrade we end up with a segment that's
			// internally contradictory: mode=driving + wayName like
			// "Baker Street → Wembley Park".
			const s = { ...segments[run.from] };
			if (label) {
				s.wayName = label;
				if (s.mode !== "train") {
					s.mode = "train";
					s.refinedMode = "train";
					s.refinedReason = `station-pair upgrade${s.refinedReason ? ` (was: ${s.refinedReason})` : ""}`;
				}
			}
			out.push(s);
			i = run.toExclusive;
			continue;
		}
		// Multi-segment / absorbed run → collapse into one train segment.
		const first = segments[run.from];
		const last = segments[run.toExclusive - 1];
		const railSegs: EnrichedSegment[] = [];
		for (let k = run.from; k < run.toExclusive; k++) {
			if (segments[k].mode !== "stationary") railSegs.push(segments[k]);
		}
		const totalWeight = railSegs.reduce((a, s) => a + (s.pointCount || 1), 0) || 1;
		const weighted = (field: (s: EnrichedSegment) => number, digits: number): number => {
			const sum = railSegs.reduce((a, s) => a + field(s) * (s.pointCount || 1), 0);
			return Math.round((sum / totalWeight) * 10 ** digits) / 10 ** digits;
		};
		const merged: EnrichedSegment = {
			startTs: first.startTs,
			endTs: last.endTs,
			mode: "train",
			refinedMode: "train",
			confidence: weighted((s) => s.confidence, 2),
			confidenceMargin: weighted((s) => s.confidenceMargin, 2),
			avgSpeed: weighted((s) => s.avgSpeed, 1),
			maxSpeed: Math.max(...railSegs.map((s) => s.maxSpeed)),
			linearity: weighted((s) => s.linearity, 2),
			pointCount: railSegs.reduce((a, s) => a + s.pointCount, 0),
			refinedReason: "merged rail run (collapsed brief pauses)",
		};
		if (label) merged.wayName = label;
		out.push(merged);
		i = run.toExclusive;
	}
	return out;
}
