/**
 * Velocity pipeline: raw PhoneTrack GPS → Kalman filter → segment classification → OSM enrichment.
 *
 * Used by both the API route and the CLI tool.
 */

import { sql } from "kysely";
import tzLookup from "tz-lookup";
import { db } from "../db/pool.js";
import { getSyncState } from "../db/sync-state.js";
import { applyHsmmPlaceOverride } from "../hmm/place-override.js";
import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { type DayState, segmentsToDayStates } from "../sleep/day-state.js";
import { detectKnownPlaceStays, type StayCandidate } from "../sleep/known-place-stays.js";
import { enrichSleepWindows, loadDaySleepWindows } from "../sleep/load.js";
import { biometricCoherence } from "./biometric-coherence.js";
import {
	type BiometricEnrichment,
	correctModeFromCadence,
	enrichSegmentWithBiometrics,
	type HrPoint,
	type SleepStageRecord,
	type StepPoint,
} from "./biometrics.js";
import { bridgeStaysWithBiometrics } from "./bridge-stays-biometrics.js";
import { useBiometricFactor } from "./factors/feature-flag.js";
import { hourProfileForRange, localSolarHour } from "./focus-places.js";
import { qualityFilterGps } from "./gps-quality.js";
import type { FilteredPoint } from "./kalman.js";
import { filterGpsTrack } from "./kalman.js";
import { loadClassificationInputs } from "./load-classification-inputs.js";
import { correctModeBySignature, gateCycling, type ModeStats } from "./mode-biometrics.js";
import {
	bestPlace,
	commonCity,
	extractCity,
	type NearbyStation,
	type NearbyWay,
	pickBestStation,
	placeLabel,
	refineMode,
	rejectImplausibleDriving,
} from "./osm.js";
import { dbOsmAdapter } from "./osm-adapter.js";
import { type PlaceCandidate, pickBestPlace } from "./place-prior.js";
import { haversineMeters, type KnownPlace, snapToPlace } from "./place-snap.js";
import { interpolateTimes, type SnappedPoint } from "./rail-snap.js";
import type { TrackSegment } from "./segments.js";
import { classifySegments, enforcePhysicalConstraints } from "./segments.js";
import { splitStaysOnEvidence } from "./stay-split.js";
import { dateBoundsUtc, fitbitTsToUnix } from "./timezone.js";
import { stationAtTrainAlight } from "./transit-place.js";
import {
	annotateUndergroundRuns,
	UNDERGROUND_LINES_RADIUS_M,
	UNDERGROUND_STATION_RADIUS_M,
} from "./underground-rail.js";

/** Format a unix-second instant as a `YYYY-MM-DD HH:MM:SS` UTC DATETIME
 *  string for filtering against `ts_utc` columns. */
export function utcSecondsToDatetimeStr(unix: number): string {
	return new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/** Parse a `YYYY-MM-DD HH:MM:SS` UTC DATETIME value from the DB into
 *  unix seconds. The mariadb driver returns DATETIME columns as `Date`
 *  objects whose UTC components literally mirror the stored bytes (any
 *  `Z` suffix is decoration, not a TZ claim); `DATE_FORMAT(...)` returns
 *  a string. Handle both by component-matching the same way
 *  `fitbitTsToUnix` does. */
export function utcDatetimeStrToSeconds(s: string | Date): number {
	const str = typeof s === "string" ? s : s.toISOString();
	const m = str.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
	if (!m) return Number.NaN;
	return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

/**
 * Load Fitbit HR + sleep stages for a UTC time window. Filters directly on
 * the derived `ts_utc` columns populated by sync/backfill (see
 * `docs/proposals/2026-05-utc-three-tier.md`); no per-row tz lookup or
 * wall-clock-string padding required. Returns empty arrays gracefully when
 * the user wasn't wearing their Fitbit.
 *
 * A tiny fallback path covers rows where `ts_utc IS NULL` — these are
 * expected to be zero in steady state after Phase B backfill, and arise
 * only when forward sync ran without any tz signal (no PhoneTrack, no
 * profile.tz). The fallback pays the legacy per-row conversion only for
 * those rows.
 */
export async function loadBiometrics(
	userId: string,
	startUtc: number,
	endUtc: number,
	tz: string | undefined,
): Promise<{ hr: HrPoint[]; sleep: SleepStageRecord[]; steps: StepPoint[] }> {
	const startUtcDt = utcSecondsToDatetimeStr(startUtc);
	const endUtcDt = utcSecondsToDatetimeStr(endUtc);

	// Legacy tz fallback chain for the rare `ts_utc IS NULL` stragglers:
	// row.tz → home_tz → request tz. See TIMEZONE.md.
	const homeTz = await getSyncState(userId, "home_tz");
	const resolveTz = (rowTz: string | null): string | undefined => rowTz ?? homeTz ?? tz;
	const padDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
	const dayBefore = padDate(startUtc - 86400);
	const dayAfter = padDate(endUtc + 86400);

	// Per-minute HR aggregate. Fitbit stores 1-second-resolution HR (~21k
	// rows per day); for segment-level mean/std the per-minute average
	// loses essentially no precision and is ~60× cheaper to load + parse.
	const hrPrimaryRows = await db()
		.selectFrom("heart_rate_intraday")
		.select([
			sql<string>`DATE_FORMAT(MIN(ts_utc), '%Y-%m-%d %H:%i:00')`.as("ts_utc"),
			sql<number>`ROUND(AVG(bpm))`.as("bpm"),
		])
		.where("user_id", "=", userId)
		.where("ts_utc", ">=", startUtcDt)
		.where("ts_utc", "<", endUtcDt)
		.groupBy(sql`DATE_FORMAT(ts_utc, '%Y-%m-%d %H:%i')`)
		.orderBy("ts_utc")
		.execute();

	const hr: HrPoint[] = hrPrimaryRows.map((r) => ({ ts: utcDatetimeStrToSeconds(r.ts_utc), bpm: Number(r.bpm) }));

	const hrFallbackRows = await db()
		.selectFrom("heart_rate_intraday")
		.select([
			sql<string>`DATE_FORMAT(MIN(ts), '%Y-%m-%d %H:%i:00')`.as("ts"),
			sql<number>`ROUND(AVG(bpm))`.as("bpm"),
			sql<string | null>`MAX(tz)`.as("tz"),
		])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.where("ts_utc", "is", null)
		.groupBy(sql`DATE_FORMAT(ts, '%Y-%m-%d %H:%i')`)
		.execute();
	for (const r of hrFallbackRows) {
		const ts = fitbitTsToUnix(r.ts, resolveTz(r.tz));
		if (Number.isNaN(ts) || ts < startUtc || ts > endUtc) continue;
		hr.push({ ts, bpm: Number(r.bpm) });
	}
	hr.sort((a, b) => a.ts - b.ts);

	const sleepPrimaryRows = await db()
		.selectFrom("sleep_stages")
		.select(["ts_utc", "stage", "duration_seconds"])
		.where("user_id", "=", userId)
		.where("ts_utc", ">=", startUtcDt)
		.where("ts_utc", "<", endUtcDt)
		.execute();

	const sleep: SleepStageRecord[] = [];
	for (const r of sleepPrimaryRows) {
		if (r.ts_utc === null) continue;
		const startTs = utcDatetimeStrToSeconds(r.ts_utc);
		sleep.push({ startTs, endTs: startTs + r.duration_seconds, stage: r.stage });
	}

	const sleepFallbackRows = await db()
		.selectFrom("sleep_stages")
		.select(["ts", "stage", "duration_seconds", "tz"])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.where("ts_utc", "is", null)
		.execute();
	for (const r of sleepFallbackRows) {
		const startTs = fitbitTsToUnix(r.ts, resolveTz(r.tz));
		if (Number.isNaN(startTs)) continue;
		const endTs = startTs + r.duration_seconds;
		if (endTs < startUtc || startTs > endUtc) continue;
		sleep.push({ startTs, endTs, stage: r.stage });
	}
	sleep.sort((a, b) => a.startTs - b.startTs);

	// Steps intraday — only non-zero minutes are stored, so the row count
	// directly reflects "user took at least one step in this minute".
	const stepsPrimaryRows = await db()
		.selectFrom("steps_intraday")
		.select(["ts_utc", "steps"])
		.where("user_id", "=", userId)
		.where("ts_utc", ">=", startUtcDt)
		.where("ts_utc", "<", endUtcDt)
		.execute();

	const steps: StepPoint[] = [];
	for (const r of stepsPrimaryRows) {
		if (r.ts_utc === null) continue;
		steps.push({ ts: utcDatetimeStrToSeconds(r.ts_utc), steps: r.steps });
	}

	const stepsFallbackRows = await db()
		.selectFrom("steps_intraday")
		.select(["ts", "steps", "tz"])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.where("ts_utc", "is", null)
		.execute();
	for (const r of stepsFallbackRows) {
		const ts = fitbitTsToUnix(r.ts, resolveTz(r.tz));
		if (Number.isNaN(ts) || ts < startUtc || ts > endUtc) continue;
		steps.push({ ts, steps: r.steps });
	}
	steps.sort((a, b) => a.ts - b.ts);

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
	/** Distinct days this cluster has been visited — frequency
	 *  prior for the place scorer. */
	uniqueDays: number;
	/** Mined hour-of-day dwell profile (24 fractions) or null for a
	 *  place mined before the column existed — the time-of-day term
	 *  of the place scorer. */
	hourProfile: number[] | null;
}

/** A focus_place is "residential" if the user has slept (covered deep-night
 *  hours) at it for at least RESIDENCE_SLEEP_THRESHOLD_H total hours. */
const RESIDENCE_SLEEP_THRESHOLD_H = 5;

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

/** Apply per-user biometric-signature correction to one segment. Synthetic
 *  gap segments (inferred-from-gap walking / `unknown` no-coverage) carry
 *  pointCount=0 and have no observations to score against — skip them. For
 *  others, aggregate HR + cadence from the loaded biometric streams and run
 *  the pure decision helper. On change, record refinedReason so the timeline
 *  shows why. */
function applyBiometricSignature(
	seg: EnrichedSegment,
	hr: HrPoint[],
	steps: StepPoint[],
	modeStats: ModeStats[],
): EnrichedSegment {
	if (seg.pointCount === 0) return seg;
	const obsHr = meanInWindow(hr, (p) => p.bpm, seg.startTs, seg.endTs);
	const obsCadence = meanInWindow(steps, (p) => p.steps, seg.startTs, seg.endTs);
	const obsSpeed = seg.avgSpeed;
	const currentMode = seg.refinedMode ?? seg.mode;
	const r = correctModeBySignature(
		{ mode: currentMode, confidenceMargin: seg.confidenceMargin, obsHr, obsCadence, obsSpeed },
		modeStats,
	);
	const effectiveMode = r.changed ? r.mode : currentMode;
	// Hard-evidence gate: a segment still labelled "cycling" is kept only
	// with genuine cycling evidence; otherwise it is demoted.
	const gate = gateCycling({ mode: effectiveMode, obsCadence, obsSpeed });
	if (gate.changed) {
		return {
			...seg,
			refinedMode: gate.mode,
			refinedReason: `cycling demoted to ${gate.mode} — no hard cycling evidence`,
		};
	}
	if (!r.changed) return seg;
	return {
		...seg,
		refinedMode: r.mode,
		refinedReason: `re-classified as ${r.mode} by biometric signature`,
	};
}

/** Rail-only OSM way subtypes used by the rail-corridor signal. Tram
 *  excluded — tram tracks frequently run in mixed traffic, so "fixes
 *  near a tram way" is not strong rail-vs-road evidence. */
const RAIL_ONLY_SUBTYPES = new Set(["rail", "subway", "light_rail", "narrow_gauge"]);

/** Drivable highway subtypes — match the candidate generator's
 *  DRIVEABLE_HIGHWAY_SUBTYPES list (residential roads up through
 *  motorways, plus tracks / living_streets). Pedestrian / cycle ways
 *  excluded. */
const DRIVABLE_HIGHWAY_SUBTYPES = new Set([
	"motorway",
	"trunk",
	"primary",
	"secondary",
	"tertiary",
	"residential",
	"service",
	"unclassified",
	"track",
	"living_street",
]);

/** Per-segment rail-vs-road proximity, aggregated across sample
 *  points. For each sample we take the minimum distance to any
 *  rail-only way and the minimum to any drivable highway; then mean
 *  across samples that had each kind in range. Samples with no rail
 *  / no road in range are skipped (so a 5-sample segment with rail
 *  in only 2 samples reports the mean of those 2). Returns nulls
 *  when no sample had a given kind nearby. */
function computeRailRoadProximity(wayResults: NearbyWay[][]): {
	meanRailDistM: number | null;
	meanDrivableRoadDistM: number | null;
} {
	const railDists: number[] = [];
	const roadDists: number[] = [];
	for (const sample of wayResults) {
		let minRail = Number.POSITIVE_INFINITY;
		let minRoad = Number.POSITIVE_INFINITY;
		for (const w of sample) {
			const d = w.distanceM;
			if (d === null || d === undefined || !Number.isFinite(d)) continue;
			if (w.type === "railway" && RAIL_ONLY_SUBTYPES.has(w.subtype)) {
				if (d < minRail) minRail = d;
			} else if (w.type === "highway" && DRIVABLE_HIGHWAY_SUBTYPES.has(w.subtype)) {
				if (d < minRoad) minRoad = d;
			}
		}
		if (Number.isFinite(minRail)) railDists.push(minRail);
		if (Number.isFinite(minRoad)) roadDists.push(minRoad);
	}
	const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
	return { meanRailDistM: mean(railDists), meanDrivableRoadDistM: mean(roadDists) };
}

/** Wrap a post-midnight stay candidate (raw fixes + known-place
 *  match) as a synthetic stationary `EnrichedSegment`. This shape is
 *  what `derivePlaceForSleep` expects — the synthetic segment never
 *  enters the day's segment output, only the sleep-place attribution
 *  candidate set. The non-place fields are filler. */
function synthesizeStayCandidateSegment(stay: StayCandidate): EnrichedSegment {
	return {
		startTs: stay.startTs,
		endTs: stay.endTs,
		mode: "stationary",
		confidence: 1,
		confidenceMargin: Number.POSITIVE_INFINITY,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 0,
		place: stay.place,
	};
}

/** Project a loaded NamedPlace down to the shape the place-prior
 *  scorer needs. Pure mapping — kept inline so the scorer stays
 *  loosely coupled to the DB-touching pipeline. */
function toPlaceCandidate(p: NamedPlace): PlaceCandidate {
	return {
		id: typeof p.id === "number" ? p.id : 0,
		centroidLat: p.centroidLat,
		centroidLon: p.centroidLon,
		radiusM: p.radiusM ?? 50,
		uniqueDays: p.uniqueDays,
		hourProfile: p.hourProfile,
	};
}

export interface EnrichedSegment extends TrackSegment {
	place?: string; // human-readable place name (for stationary segments)
	city?: string; // city/town/village (for stationary segments) — frontend groups consecutive same-city segments
	wayName?: string; // road/rail name (for moving segments)
	refinedMode?: string; // OSM-refined transport mode (may differ from heuristic mode)
	refinedReason?: string;
	displayTz?: string; // IANA tz to render the segment's timestamps in (frontend uses this instead of browser tz)
	biometrics?: BiometricEnrichment;
	snappedPath?: SnappedPoint[]; // derived: this train segment drawn on the OSM rail track — see annotateSnappedPaths
}

/** One phone-battery reading: a charge level (integer percent, 0–100)
 *  at a wall-clock instant. Sourced from the `battery` field PhoneTrack
 *  records on each GPS fix — see `batterySeries`. */
export interface BatterySample {
	ts: number;
	level: number;
}

/** Reduce the day's per-fix battery readings to a compact series for
 *  the battery chart. A fix is kept iff its level differs from the
 *  reading before or after it, so each constant run collapses to just
 *  its two endpoints — the chart still draws a flat line across the
 *  run and a clean step at each change. Fixes with no battery reading
 *  are dropped. Assumes `points` is in ascending-`ts` order, which is
 *  how `fetchTrackPoints` returns them. */
export function batterySeries(points: { ts: number; battery: number | null }[]): BatterySample[] {
	const read: BatterySample[] = [];
	for (const p of points) {
		if (p.battery !== null) read.push({ ts: p.ts, level: p.battery });
	}
	return read.filter((s, i) => {
		const prev = read[i - 1];
		const next = read[i + 1];
		return prev === undefined || next === undefined || s.level !== prev.level || s.level !== next.level;
	});
}

export interface VelocityResult {
	points: FilteredPoint[];
	segments: EnrichedSegment[];
	/** Non-overlapping day state sequence — bottom layer of the
	 *  three-altitude data model. Derived from `segments` plus the
	 *  user's main sleep windows. Sleep at a stationary place is
	 *  the `sleeping` mode; sleep while moving is an `asleep:true`
	 *  attribute on the moving state. Adjacent same-state runs
	 *  merge. See `src/sleep/day-state.ts`. */
	states: DayState[];
	/** The day's phone-battery trace, compressed to run boundaries.
	 *  Derived from the same PhoneTrack fixes as `points`; the Day
	 *  view renders it as a standalone chart. */
	battery: BatterySample[];
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

	const bounds = dateBoundsUtc(date, tz);
	// Phase 2a of docs/proposals/2026-06-deterministic-fixtures.md:
	// the eager DB / HTTP reads at the top of the pipeline are
	// consolidated into a single named `loadClassificationInputs`
	// call so future phases can swap it for a fixture loader. Same
	// queries, same wire calls, same projections — just named.
	const inputs = await time("loadInputs", loadClassificationInputs(config, { userId, date, displayTz: tz ?? "UTC" }));
	const { today: raw, morning: morningRaw, priorEvening: prevEveningRaw } = inputs.phonetrack;
	const inDay = raw.filter((p) => p.ts >= bounds.startUtc && p.ts < bounds.endUtc);

	// Battery trace: derived straight from the raw in-day fixes, before
	// the GPS quality / accuracy filters touch them — a fix dropped for
	// an incoherent position still carries a valid battery reading.
	const battery = batterySeries(inDay);

	// GPS quality control: drop physically-incoherent runs (underground
	// cell-tower garbage) before anything else touches the data. The
	// dropped fixes leave an honest temporal gap that `inferTransitGaps`
	// bridges downstream. See src/geo/gps-quality.ts.
	const cleaned = timeSync("gpsQuality", () => qualityFilterGps(inDay));

	// Place-snap: if a fix is unambiguously close to a known cluster (home,
	// work, etc.), pull it to the cluster centroid. Reduces GPS noise around
	// well-known locations and stabilises both segment timing and labels.
	const knownPlaces = inputs.knownPlaces;
	const snapped =
		knownPlaces.length > 0
			? cleaned.map((p) => {
					const r = snapToPlace({ lat: p.lat, lon: p.lon, accuracy: p.accuracy }, knownPlaces);
					return r.snapped ? { ...p, lat: r.lat, lon: r.lon, accuracy: r.accuracy } : p;
				})
			: cleaned;

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
		// Non-enriched path: no OSM, no biometrics, no sleep — caller
		// requested raw segments only. `states` is still produced for
		// shape consistency; without enrichment it just trivially
		// reflects the raw segment sequence (sleep windows = empty,
		// no rewrite).
		const states = segmentsToDayStates(segments as EnrichedSegment[], []);
		return { points, segments, states, battery };
	}

	const N_SAMPLES = 5;

	// Kick off biometrics + per-user mode-signature loads in parallel with OSM
	// enrichment — all I/O-bound. The biometric streams are needed for cadence-
	// based mode correction (between OSM enrichment and merge) plus the final
	// per-segment enrichment after merge. The per-user mode signatures
	// (modeStats) are needed either by the legacy `applyBiometricSignature`
	// pass after OSM enrichment, or — when `useBiometricFactor()` is on — by
	// the factor scorer's candidate generator inside refineMode itself, in
	// which case we need them before enrichment starts.
	// Already loaded by `loadClassificationInputs`. Kept as resolved
	// Promises so the existing `await biometricsPromise` / `await
	// modeStatsPromise` call sites downstream don't need changes.
	const biometricsPromise = Promise.resolve(inputs.biometrics);
	const modeStatsPromise = Promise.resolve(inputs.modeBiometrics);
	const biometricFactorOn = useBiometricFactor();
	// When the biometric factor is on, refineMode needs per-segment hr/cadence
	// + modeStats inside the enrichment map, so await both biometric loads
	// before the Promise.all. When it is off, the streams are only consumed
	// after enrichment and we keep the original parallelism — except: we
	// also need biometrics *now* to drive `splitStaysOnEvidence`
	// (the multi-signal weighted stay-split). That blocks the request
	// path on the biom load; acceptable cost in exchange for honest
	// mid-stay-departure detection (see stay-split.ts).
	const preEnrichBiometrics = biometricFactorOn ? await biometricsPromise : null;
	const preEnrichModeStats = biometricFactorOn ? await modeStatsPromise : null;
	const biomForStaySplit = preEnrichBiometrics ?? (await biometricsPromise);
	const splitSegments = timeSync("staySplit", () =>
		splitStaysOnEvidence(segments, points, { hr: biomForStaySplit.hr, steps: biomForStaySplit.steps }),
	);
	// Multi-signal stay-continuity merge: heal stays the trajectory
	// layer fragmented by a brief no-fix gap, when HR-resting + zero
	// steps in the gap window confirm the user never actually moved.
	// Symmetric to splitStaysOnEvidence above — same biometric series,
	// opposite direction. Targets the Pizza Union / toilet-break class
	// of failure (ground-truth #185).
	const segCentroids: (readonly [number, number] | null)[] = splitSegments.map((s) => {
		if (s.mode !== "stationary") return null;
		const segPoints = points.filter((p) => p.ts >= s.startTs && p.ts <= s.endTs);
		if (segPoints.length === 0) return null;
		const cLat = segPoints.reduce((sum, p) => sum + p.lat, 0) / segPoints.length;
		const cLon = segPoints.reduce((sum, p) => sum + p.lon, 0) / segPoints.length;
		return [cLat, cLon] as const;
	});
	const refinedSegments = timeSync("bridgeStays", () =>
		bridgeStaysWithBiometrics({
			segments: splitSegments,
			centroids: segCentroids,
			hr: biomForStaySplit.hr,
			steps: biomForStaySplit.steps,
		}),
	);

	// Enrich each (post-stay-split) segment with OSM data
	const enrichStart = Date.now();
	const enriched: EnrichedSegment[] = await Promise.all(
		refinedSegments.map(async (seg, i) => {
			// Synthetic gap segments (inferred-walking or `unknown`) carry
			// pointCount=0 — no real GPS data. Enriching with road names /
			// OSM places would invent context we don't have. Pass them
			// through with their refinedReason intact.
			if (seg.pointCount === 0) return seg;
			const segPoints = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
			if (segPoints.length === 0) return seg;

			try {
				if (seg.mode === "stationary") {
					const cLat = segPoints.reduce((s, p) => s + p.lat, 0) / segPoints.length;
					const cLon = segPoints.reduce((s, p) => s + p.lon, 0) / segPoints.length;

					// Transit continuity: a stay immediately after a train,
					// within station range, is at the station the user just
					// alighted at — not at a co-located café (2026-05-22
					// Finchley Road ambulance wait, mislabelled "Loft Coffee
					// Company"). Takes precedence over the focus_place /
					// OSM-amenity picker below.
					const alightStation = await stationAtTrainAlight(refinedSegments[i - 1], cLat, cLon, inputs.osm);
					if (alightStation !== null) {
						const namedPlace = await bestPlace(inputs.osm, cLat, cLon, { preferResidential: false });
						const city = extractCity(namedPlace);
						return { ...seg, place: alightStation, ...(city ? { city } : {}) };
					}

					// Probabilistic place assignment: rank candidates from
					// focus_places by combined log-likelihood (Gaussian on
					// distance, σ = empirical radius) + log-prior (visit
					// frequency, time-of-day match against sleep_hours /
					// awake_hours). Replaces the old snap-radius +
					// residential-hours-threshold + amenity-gate chain.
					// See `src/geo/place-prior.ts`.
					const isSleepWindow = hasOvernightPresence(seg.startTs, seg.endTs, cLon);
					const stayHourProfile = hourProfileForRange(seg.startTs, seg.endTs, cLon);
					// Magnetic anchoring: pass biometric coherence so the
					// scorer can boost established focus_places when the
					// segment's HR + steps confirm the user was actually
					// sitting (vs walking past). See
					// `docs/proposals/2026-06-magnetic-focus-places.md`.
					const segBs = biometricCoherence({
						startTs: seg.startTs,
						endTs: seg.endTs,
						hr: biomForStaySplit.hr,
						steps: biomForStaySplit.steps,
					});
					const winner =
						knownPlaces.length > 0
							? pickBestPlace(knownPlaces.map(toPlaceCandidate), cLat, cLon, {
									stayHourProfile,
									biometricCoherence: segBs,
								})
							: null;

					if (winner !== null) {
						const wp = knownPlaces.find((p) => p.id === winner.winner.id) ?? null;
						if (wp !== null) {
							// Snap the centroid to the place's stored centroid
							// so downstream OSM-amenity / city lookup runs at the
							// place's "true" coordinates instead of the day's
							// noisy aggregate.
							const placeLat = wp.centroidLat;
							const placeLon = wp.centroidLon;

							// Personal label wins outright — but only for the
							// "intent" labels Home / Work. The "Stay" category
							// label is just a clustering bucket, not a useful
							// timeline name; fall through to address lookup.
							if (wp.displayName === "Home" || wp.displayName === "Work") {
								const namedPlace = await bestPlace(inputs.osm, placeLat, placeLon, { preferResidential: true });
								const namedCity = extractCity(namedPlace);
								return {
									...seg,
									place: wp.displayName,
									...(namedCity ? { city: namedCity } : {}),
								};
							}
							// Mined cluster-level amenity_label (majority-vote
							// across the user's prior visits to this cluster)
							// when the cluster isn't residential. Residential
							// clusters fall through to the address lookup —
							// A residential address beats a co-located cafe
							// label because the cluster's sleep_hours dwarfs
							// its awake_hours.
							const isResidential = wp.sleepHours >= RESIDENCE_SLEEP_THRESHOLD_H;
							if (!isResidential && wp.amenityLabel) {
								const namedPlace = await bestPlace(inputs.osm, placeLat, placeLon, { preferResidential: false });
								const namedCity = extractCity(namedPlace);
								return {
									...seg,
									place: wp.amenityLabel,
									...(namedCity ? { city: namedCity } : {}),
								};
							}
							// Residential without a personal label, or no mined
							// amenity_label — fall through to bestPlace at the
							// snapped centroid. Prefer the address when the
							// cluster is residential OR the mining gate found
							// no confident venue here (null amenity_label): a
							// venue-less place — e.g. an evening-only residence
							// the sleep gate misses — must show a neutral
							// area/address, not a low-confidence nearby park.
							const venueless = wp.amenityLabel === null;
							const place = await bestPlace(inputs.osm, placeLat, placeLon, {
								preferResidential: isResidential || venueless,
							});
							if (!place) return seg;
							const city = extractCity(place);
							return {
								...seg,
								place: placeLabel(place),
								...(city ? { city } : {}),
							};
						}
					}

					// No focus_place crossed the posterior floor — this is a
					// stay somewhere new. Use the day's centroid and the
					// per-stay overnight check to decide residential preference.
					const preferResidential = isSleepWindow;
					const place = await bestPlace(inputs.osm, cLat, cLon, { preferResidential });
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
					Promise.all(sampleIdxs.map((i) => inputs.osm.nearbyWays(segPoints[i].lat, segPoints[i].lon))),
					// Endpoint reverseGeocode: tag the segment with a city iff
					// both endpoints agree. A walk inside one city gets a city
					// header; a drive between two cities stays untagged.
					inputs.osm.reverseGeocode(movingStart.lat, movingStart.lon),
					inputs.osm.reverseGeocode(movingEnd.lat, movingEnd.lon),
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
				// Rail-vs-road proximity per sample point — feeds the
				// rail-corridor factor. For each sample's nearbyWays list,
				// the minimum distance to any rail-only way and the minimum
				// to any drivable highway. Mean across samples where each
				// kind had something in range; null when no sample had it.
				// The factor scorer uses the ratio to discriminate train
				// from driving when speed-emission can't.
				const railRoad = computeRailRoadProximity(wayResults);
				// Under USE_BIOMETRIC_FACTOR, pass per-segment hr/cadence + the
				// loaded mode signatures into refineMode so the factor scorer's
				// candidate generator can filter biologically-implausible
				// candidates. Without the flag, refineMode runs with no
				// biometric context and the legacy `applyBiometricSignature`
				// pass below does the corresponding work as a post-step.
				const biometricCtx =
					biometricFactorOn && preEnrichBiometrics && preEnrichModeStats
						? {
								obs: {
									hr: meanInWindow(preEnrichBiometrics.hr, (p) => p.bpm, seg.startTs, seg.endTs),
									cadence: meanInWindow(preEnrichBiometrics.steps, (p) => p.steps, seg.startTs, seg.endTs),
									speed: seg.avgSpeed,
								},
								stats: preEnrichModeStats,
							}
						: undefined;
				const refined = refineMode(
					seg.mode,
					seg.avgSpeed,
					aggregated,
					biometricCtx,
					seg.confidenceMargin,
					process.env.FACTOR_DEBUG === "1"
						? `[${new Date(seg.startTs * 1000).toISOString().slice(11, 16)}-${new Date(seg.endTs * 1000).toISOString().slice(11, 16)}Z]`
						: undefined,
					railRoad,
				);
				// Physical-plausibility override: a tube ride under a road
				// can look like driving to refineMode (the road is the
				// closest OSM way). Demote when the max speed exceeds
				// urban-non-motorway limits and a subway is parallel.
				const plausible = rejectImplausibleDriving(
					{ mode: refined.mode, wayName: refined.wayName },
					seg.maxSpeed,
					aggregated,
				);
				const movingCity = commonCity(startPlace, endPlace);
				return {
					...seg,
					refinedMode: plausible.mode,
					refinedReason: plausible.reason ?? refined.reason,
					wayName: plausible.wayName,
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
	//
	// When USE_BIOMETRIC_FACTOR is on, refineMode above has already
	// consulted the per-user biometric signatures via the factor scorer's
	// candidate generator — running this pass on top would double-correct
	// (and bypass the scorer's principled aggregation in favour of a
	// hard-coded cascade). Skip in that case; otherwise this is the
	// production path.
	const modeStats = preEnrichModeStats ?? (await modeStatsPromise);
	const biometricCorrected = biometricFactorOn
		? corrected
		: timeSync("biometricCorrect", () => corrected.map((seg) => applyBiometricSignature(seg, hr, steps, modeStats)));

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

	const withStations = await annotateRailRuns(
		merged,
		points,
		(lat, lon) => inputs.osm.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
		(lat, lon) => inputs.osm.linesAtPoint(lat, lon),
	);

	// Underground reconstruction: a tube ride leaves only coarse
	// cell-network fixes, which annotateRailRuns cannot resolve. Mine
	// those coarse fixes (from the raw, pre-Kalman track) to identify the
	// line and split the swallowing walk into walk → train → walk.
	const withUnderground = await time(
		"undergroundRail",
		annotateUndergroundRuns(
			withStations,
			inDay,
			(lat, lon) => inputs.osm.nearbyStations(lat, lon, UNDERGROUND_STATION_RADIUS_M),
			(lat, lon) => inputs.osm.linesAtPoint(lat, lon, UNDERGROUND_LINES_RADIUS_M),
		),
	);

	// Absorb a platform / concourse wait into the boarding of its train
	// run, so a station wait doesn't surface as a standalone stay
	// mislabelled with the nearest focus place.
	const withBoarding = await time(
		"boardingPlatform",
		absorbBoardingPlatform(withUnderground, points, (lat, lon) =>
			inputs.osm.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
		),
	);

	// Absorb a transit interchange — a run of short stationary segments
	// between a train and onward movement — into the preceding train,
	// so it doesn't surface as a phantom place-stay. See absorbInterchanges.
	const withInterchanges = timeSync("interchange", () => absorbInterchanges(withBoarding));

	// Absorb a phantom drive-stop — a brief stationary segment
	// sandwiched between two driving segments with zero/near-zero steps
	// across it. The biometric data confirms the user stayed in the
	// vehicle; the stop was just GPS noise at a traffic light or in
	// dense urban congestion. See absorbDriveStops + the 2026-06-02
	// "phantom Lanesborough" case in conversation context.
	const withAbsorbedDriveStops = timeSync("driveStops", () =>
		absorbDriveStops(withInterchanges, biomForStaySplit.steps),
	);

	// Physical constraint: back-to-back train legs must share a station.
	// You can't step off one train and instantly be on another at a
	// different station — so a leg whose independently-resolved boarding
	// contradicts the previous leg's alighting is corrected to board
	// where that leg alighted. Runs after the interchange absorber so it
	// sees the final train-leg adjacency, and before rail-snap so the
	// snap keys off the corrected station pair. See reconcileAdjacentRailLegs.
	const withReconciledRail = timeSync("railReconcile", () => reconcileAdjacentRailLegs(withAbsorbedDriveStops));

	// Rail-snap: attach the precomputed rail-track geometry to each
	// train run whose route is in rail_route_cache (filled offline by
	// refresh-rail-routes). One indexed lookup — purely additive, the
	// raw track is untouched. See annotateSnappedPaths.
	const withSnapped = timeSync("railSnap", () => annotateSnappedPaths(withReconciledRail, inputs.railRouteCache));

	// Per-segment displayTz: the IANA tz the frontend should use to render
	// the segment's wall-clock. Derived from the segment's geographic
	// location (centroid for stationary, midpoint for moving). Lets the UI
	// show times "as the user experienced them" — morning at parents in
	// CEST, evening home in BST, even across a travel day. Fallback to
	// home_tz / Europe/Amsterdam when no points cover the segment (inferred
	// gap segments).
	const homeTz = (await getSyncState(userId, "home_tz")) ?? "Europe/Amsterdam";
	const withDisplayTz = timeSync("displayTz", () =>
		withSnapped.map((s): EnrichedSegment => {
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
	const enrichedSegments = timeSync("biomEnrich", () =>
		withDisplayTz.map((s) => ({ ...s, biometrics: enrichSegmentWithBiometrics(s, hr, sleep, steps) })),
	);

	// HSMM place override — when an HSMM decode exists in decoded_days
	// for this (user, date), use its place picks to override the
	// pipeline's `place` attribution on stationary segments. The HSMM
	// scores ~96% place vs ground truth (2026-05-25 audit) where the
	// pipeline drifts on multi-candidate clusters. Falls back to the
	// pipeline's label when no decode exists (cron hasn't run yet) or
	// the HSMM is uncertain.
	const hmmDecode = inputs.hsmmDecode;
	const overridden = hmmDecode
		? timeSync("hsmmOverride", () => {
				const placeLookup = new Map<number, { displayName: string | null }>();
				for (const p of knownPlaces) {
					if (typeof p.id === "number") placeLookup.set(p.id, { displayName: p.displayName });
				}
				return applyHsmmPlaceOverride(enrichedSegments, hmmDecode, placeLookup);
			})
		: enrichedSegments;
	// Final merge pass — by this point HSMM may have attached a place
	// to a segment that was un-placed at the earlier merge (e.g., a
	// walking-reclassified-to-stationary segment that the place-attribution
	// stage skipped because its raw `mode` was still "walking"). Re-run
	// mergeAdjacentStays so two consecutive same-place segments don't
	// surface as duplicates — the 2026-06-02 "two Home stays" case.
	const withBiometrics = timeSync("finalMerge", () => mergeAdjacentStays(overridden));

	const total = Date.now() - t0;
	const summary = Object.entries(phaseTimes)
		.map(([k, v]) => `${k}=${v}ms`)
		.join(" ");
	console.log(`velocity ${date} user=${userId}: total=${total}ms ${summary} segments=${withBiometrics.length}`);

	// Day-state composition (bottom layer of the three-altitude model):
	// load the main sleep windows that bracket this day, derive each
	// window's place from the surrounding stationary segments, and
	// compose the non-overlapping state sequence. Sleep at a stationary
	// place rewrites the mode to "sleeping"; sleep while moving sets
	// `asleep: true` as an attribute. See `src/sleep/day-state.ts`.
	//
	// For sleep-place attribution, augment today's segments with
	// synthetic stationary candidates derived from the neighbouring
	// days' fixes. Two cases:
	//   - Next-day morning fixes: handle the post-midnight evening
	//     sleep case (taxi home from a late hospital stay, then sleep
	//     at home; today's last segment is the hospital, but the user
	//     actually slept at home).
	//   - Prior-day evening fixes: handle the morning sleep case
	//     where today's first stationary segment is hours later
	//     (sleeping starts before that segment, and the user actually
	//     slept where they stayed yesterday evening — e.g. a
	//     guesthouse from the night before).
	// The synthetic candidates are only fed to derivePlaceForSleep —
	// they never enter the day's segment output. Each candidate's
	// label is re-resolved through `bestPlace` (preferResidential: true,
	// since these stays sit inside the sleep window) so a lodging POI
	// near the centroid wins over a focus_place's generic "Stay" label
	// — without this, a hotel stay attaches "Stay" instead of the
	// hotel's name. See `src/sleep/known-place-stays.ts`.
	const morningStays = timeSync("morningStays", () =>
		detectKnownPlaceStays(
			morningRaw.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon })),
			knownPlaces,
		),
	);
	const prevEveningStays = timeSync("prevEveningStays", () =>
		detectKnownPlaceStays(
			prevEveningRaw.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon })),
			knownPlaces,
		),
	);
	// Only re-resolve via bestPlace when the focus_place match returned
	// a generic placeholder ("Stay") — the OSM POI lookup then has a
	// chance to find a lodging name. When the focus_place already has
	// a specific label (Home, Work, named hotel from a prior re-mine),
	// keep it: bestPlace would otherwise replace "Home" with the
	// residential street address.
	const isGenericStayLabel = (s: string): boolean => s === "Stay";
	const resolvedSleepStays = await time(
		"resolveSleepStays",
		Promise.all(
			[...morningStays, ...prevEveningStays].map(async (stay) => {
				if (!isGenericStayLabel(stay.place)) return stay;
				const resolved = await bestPlace(inputs.osm, stay.centroidLat, stay.centroidLon, { preferResidential: true });
				const placeName = resolved ? placeLabel(resolved) : stay.place;
				return { ...stay, place: placeName };
			}),
		),
	);
	const sleepPlaceCandidates: EnrichedSegment[] = [
		...withBiometrics,
		...resolvedSleepStays.map(synthesizeStayCandidateSegment),
	];
	const rawSleep = await loadDaySleepWindows(userId, date);
	const sleepWindows = enrichSleepWindows(rawSleep, sleepPlaceCandidates);
	const states = timeSync("dayStates", () => segmentsToDayStates(withBiometrics, sleepWindows));

	return { points, segments: withBiometrics, states, battery };
}

/**
 * Merge two consecutive stationary segments that resolved to the same `place`
 * label and are separated by ≤ 5 min. Reflects the user's intent: a brief
 * pause that lands inside the same venue should read as one stay, not two.
 *
 * Chains (A, A, A) collapse into one. We deliberately do NOT collapse across
 * a real movement segment yet — keeps the post-step trivially correct.
 */
/** Max duration of a brief intermediate segment we'll bridge across when
 *  it sits between two same-place stays. A user genuinely stepping out
 *  for more than ~10 min is doing something the timeline should surface,
 *  not be silently absorbed. */
const STAY_BRIDGE_MAX_GAP_S = 10 * 60;

/** Max average speed of the intermediate segment. A GPS-multipath phantom
 *  walk has near-zero avg speed (a few outliers drag pointwise speed up
 *  briefly, but the time-weighted average stays sub-walking). A real
 *  excursion — even a brief one — averages 3+ km/h. */
const STAY_BRIDGE_MAX_AVG_KMH = 2;

export function mergeAdjacentStays(segments: EnrichedSegment[]): EnrichedSegment[] {
	const effectiveMode = (s: EnrichedSegment): string => s.refinedMode ?? s.mode;
	const result: EnrichedSegment[] = [];
	for (const seg of segments) {
		const prev = result[result.length - 1];
		// Direct adjacency: two stationary segments at the same place,
		// back-to-back. The classifier sometimes splits a continuous stay
		// when GPS goes briefly dark or jitters; collapse them. Use
		// `refinedMode ?? mode` so a walking segment that biometricCorrect
		// re-classified to stationary still merges with its same-place
		// neighbour — the 2026-06-02 "two consecutive Home stays" case.
		if (
			prev &&
			effectiveMode(prev) === "stationary" &&
			effectiveMode(seg) === "stationary" &&
			prev.place &&
			prev.place === seg.place &&
			seg.startTs - prev.endTs <= 5 * 60
		) {
			prev.endTs = seg.endTs;
			prev.pointCount += seg.pointCount;
			continue;
		}
		// Bridge over a brief non-stationary segment when bracketed by
		// two stays at the same place. The triggering shape is
		// [stay @ X, brief move, stay @ X]: a GPS multipath spike
		// inside a continuous stay produced a fake "walking" segment
		// (typically with avg ≤ 2 km/h — well below walking pace,
		// because most fixes are still at the table and only one or
		// two outliers drag the position).
		const prevPrev = result[result.length - 2];
		if (
			prev &&
			prevPrev &&
			effectiveMode(seg) === "stationary" &&
			effectiveMode(prevPrev) === "stationary" &&
			// Bridge a middle segment that the *raw* classifier called
			// non-stationary — including ones biometricCorrect later
			// re-classified to stationary. Using `effectiveMode` here
			// would wrongly exclude reclassified middles, which are
			// exactly the GPS-jittered "moving sliver" the bridge is
			// for. See the 2026-05-22 Royal Free 23:49-23:54 regression
			// caught when this predicate was naively unified.
			prev.mode !== "stationary" &&
			prevPrev.place &&
			prevPrev.place === seg.place &&
			prev.endTs - prev.startTs <= STAY_BRIDGE_MAX_GAP_S &&
			prev.avgSpeed <= STAY_BRIDGE_MAX_AVG_KMH
		) {
			result.pop(); // drop the phantom-move
			prevPrev.endTs = seg.endTs;
			prevPrev.pointCount += prev.pointCount + seg.pointCount;
			continue;
		}
		result.push({ ...seg });
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
 * avgSpeed >= 7). A maximal run of these is a single journey: a multi-
 * station tube ride that surfaced for one fix mid-route shows up as
 * train + inferred-gap + train (different modes, so mergeAdjacentMoving
 * leaves them separate), but it's one journey and gets one label.
 *
 * Per run, we look up nearby stations at the outer-bounding fixes (last fix
 * at-or-before run start, first fix at-or-after run end) and label every
 * segment in the run with "<board> → <alight>". This fixes the mid-ride-
 * fix false-alight: a noisy mid-ride fix near an intermediate station
 * can't produce an annotation for that station because the run's outer
 * fixes are at the true board/alight platforms.
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
/** Tighter threshold for the alighting lookup. A train decelerating
 *  through a station can sit at 5-15 km/h — the looser
 *  `POST_TRANSIT_SPEED_KMH` accepts those as "the user is off the
 *  train" and resolves the alight station to whatever the train is
 *  currently passing. Below 5 km/h the user is genuinely walking or
 *  standing on a platform and the location is the actual disembark.
 *  See the failure-class for "decelerating train through a non-
 *  disembark station." */
const POST_TRANSIT_ALIGHT_SPEED_KMH = 5;

/** A slow fix is a mid-ride dwell (not the real alight) if a transit-
 *  speed fix follows within this window. The train stopped at a
 *  station, the user stayed on board, the train resumed. The actual
 *  alight is later. 2 min is long enough to cover a typical platform
 *  dwell + train re-acceleration; shorter than any legitimate alight-
 *  to-walking-pace transition. */
const MID_RIDE_DWELL_RESUME_S = 120;

/** How far back in time to scan for a platform-train-platform fix
 *  pattern that suggests the velocity classifier closed the train
 *  segment's startTs too late. 15 minutes accommodates a multi-
 *  station tube ride whose initial portion got classified as walking
 *  because the per-station platform stops dominated the window
 *  median. */
const PLATFORM_PATTERN_WALKBACK_S = 900;
/** Speeds at or below this are "near-stationary" — the user is
 *  standing on the platform, not still walking towards it. The
 *  boarding-platform chain walks backwards through these only,
 *  stopping at the first walking-pace fix. That separates the
 *  platform-wait cluster from the approach walk past a closer
 *  station (the "walked past an intermediate station to board at the
 *  next one" pattern). The looser PLATFORM_SLOW_KMH still bounds
 *  the chain's outer edge — once we've collected a near-stationary
 *  cluster, we don't re-extend through anything > 8 km/h. */
const BOARDING_STILL_KMH = 3;
/** Speeds at or above this are clearly train-in-motion. */
const PLATFORM_TRAIN_KMH = 30;
/** Maximum time gap between consecutive slow fixes that we still
 *  consider part of the same boarding-platform chain. A user walking
 *  to a different station has a slow-fix gap of several minutes (or
 *  no fix at all because the phone went to power-save). Inside a
 *  station / on a platform / on a stopping-train sequence, the gap
 *  rarely exceeds ~3 minutes between recorded fixes. */
const PLATFORM_MAX_GAP_S = 180;
/** Maximum geographic spread of a "platform cluster" of slow fixes.
 *  Inside one station, fixes cluster within ~50m. Allowing 150m
 *  permits a short walk between adjacent platforms during a transfer
 *  while still rejecting a walking trail across multiple blocks. */
const PLATFORM_MAX_SPREAD_M = 150;

/**
 * Detect a platform-train-platform pattern in the fixes preceding
 * a rail run's classifier-given startTs, and return the earliest
 * slow fix that's part of that pattern. This is the *actual*
 * boarding fix — annotateRailRuns uses it as `slowBefore` to look
 * up the boarding station.
 *
 * Returns null when no train-speed fix appears in the lookback
 * window (so the classifier-given startTs is trustworthy) or when
 * no slow fix is connected to the train-pattern.
 *
 * Pure helper for unit testing — no DB calls, no async.
 */
export function findBoardingPlatformFix(points: FilteredPoint[], startTs: number): FilteredPoint | null {
	const windowStart = startTs - PLATFORM_PATTERN_WALKBACK_S;
	const windowFixes = points.filter((p) => p.ts >= windowStart && p.ts <= startTs).sort((a, b) => a.ts - b.ts);
	if (windowFixes.length === 0) return null;

	// Find the earliest train-speed fix in the window. If none, the
	// classifier's startTs is already at-or-before the first train
	// signal we have — no platform extension to do.
	let firstFastIdx = -1;
	for (let i = 0; i < windowFixes.length; i++) {
		if (windowFixes[i].speed_kmh >= PLATFORM_TRAIN_KMH) {
			firstFastIdx = i;
			break;
		}
	}
	if (firstFastIdx === -1) return null;

	// Anchor-and-extend: walk backward from firstFast until we find
	// the first near-stationary fix (the user definitely on the
	// platform). From there, keep extending backwards through more
	// near-stationary fixes — clustered within PLATFORM_MAX_SPREAD_M
	// and contiguous within PLATFORM_MAX_GAP_S — until we hit a
	// walking-pace fix. The earliest near-stationary fix is the
	// boarding-station anchor.
	//
	// Why a two-phase walk: the platform-train-platform pattern (today
	// already tested in tests/velocity.test.ts) has accelerating
	// fixes (walking-pace, 4-8 km/h) between the boarding-platform
	// fix and the first train-speed fix. We need to walk PAST those
	// to find the platform anchor. But once we have an anchor, a
	// further-back walking fix means the user was still approaching
	// — that's where the chain ends.
	const isStill = (p: FilteredPoint): boolean => p.speed_kmh < BOARDING_STILL_KMH;
	let anchorIdx = -1;
	for (let i = firstFastIdx - 1; i >= 0; i--) {
		const p = windowFixes[i];
		if (windowFixes[firstFastIdx].ts - p.ts > PLATFORM_PATTERN_WALKBACK_S) break;
		if (isStill(p)) {
			anchorIdx = i;
			break;
		}
	}
	let earliestIdx = anchorIdx;
	if (anchorIdx >= 0) {
		const anchorLat = windowFixes[anchorIdx].lat;
		const anchorLon = windowFixes[anchorIdx].lon;
		let prevChainTs = windowFixes[anchorIdx].ts;
		for (let i = anchorIdx - 1; i >= 0; i--) {
			const p = windowFixes[i];
			if (!isStill(p)) break;
			if (prevChainTs - p.ts > PLATFORM_MAX_GAP_S) break;
			if (haversineMeters(p.lat, p.lon, anchorLat, anchorLon) > PLATFORM_MAX_SPREAD_M) break;
			earliestIdx = i;
			prevChainTs = p.ts;
		}
	}

	return earliestIdx >= 0 ? windowFixes[earliestIdx] : null;
}

export async function annotateRailRuns(
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]> = (lat, lon) =>
		dbOsmAdapter.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
	linesLookup: (lat: number, lon: number) => Promise<Set<string>> = (lat, lon) => dbOsmAdapter.linesAtPoint(lat, lon),
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
	//
	// A short non-rail-like segment bookended by rail-like segments
	// (caller checks bookends) is almost certainly a platform
	// interchange. Three disjunctive signals confirm it isn't a real
	// activity between train legs:
	//   - duration ≤ 5 min (a real stop is longer)
	//   - segment avgSpeed ≤ walking pace, OR
	//   - the segment's GPS points cluster within TRAIN_DWELL_RADIUS_M
	//     of their centroid.
	//
	// Either signal alone is enough. The classifier-reported avgSpeed
	// is wrong sometimes (GPS jitter at a platform inflates instant-
	// speeds, but the average smooths them out — usually). The GPS
	// tightness is wrong sometimes (sparse fixes with multipath spikes
	// inflate the apparent spread — the actual April 29 prod case had
	// 7 fixes covering 2.8 km of apparent path with avgSpeed 4.7 km/h).
	// Trusting whichever signal looks sane catches both failure modes.
	const TRAIN_PAUSE_MAX_SEC = 5 * 60;
	const TRAIN_PAUSE_MAX_AVG_KMH = 10;
	const TRAIN_DWELL_RADIUS_M = 100;
	const TRAIN_DWELL_PERCENTILE = 0.8;
	const couldBeTrainPause = (s: EnrichedSegment): boolean => {
		if (s.endTs - s.startTs > TRAIN_PAUSE_MAX_SEC) return false;
		if (s.mode === "stationary") return true;
		if (s.avgSpeed <= TRAIN_PAUSE_MAX_AVG_KMH) return true;
		// Fallback: GPS-cluster check for the case where the classifier
		// over-estimated avgSpeed (instant-speed spikes at a platform).
		const segPoints = points.filter((p) => p.ts >= s.startTs && p.ts <= s.endTs);
		if (segPoints.length < 2) return false;
		const cLat = segPoints.reduce((sum, p) => sum + p.lat, 0) / segPoints.length;
		const cLon = segPoints.reduce((sum, p) => sum + p.lon, 0) / segPoints.length;
		const distances = segPoints.map((p) => haversineMeters(p.lat, p.lon, cLat, cLon)).sort((a, b) => a - b);
		const idx = Math.min(distances.length - 1, Math.floor(distances.length * TRAIN_DWELL_PERCENTILE));
		return distances[idx] <= TRAIN_DWELL_RADIUS_M;
	};

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
			// mid-route. A subway line that surfaces between stations
			// means the first fix at-or-after the run's endTs can be a
			// real GPS reading at ~30 km/h mid-train. Skipping
			// transit-speed fixes gets us to the actual disembark-and-
			// walk-near-station fix. Fall back to any fix if none qualify.
			const slow = (p: FilteredPoint): boolean => p.speed_kmh < POST_TRANSIT_SPEED_KMH;
			// First check whether the classifier's startTs is too late.
			// When the per-window scorer averages over a stop-and-go
			// platform sequence, the early part of a multi-station
			// tube ride can land in the preceding "walking" segment.
			// findBoardingPlatformFix walks back through the
			// platform-train-platform fix pattern and returns the true
			// boarding fix; if no such pattern exists, slowBefore
			// falls through to the prior latest-slow-fix lookup.
			const platformBoardingFix = findBoardingPlatformFix(points, startTs);
			const slowBefore =
				platformBoardingFix ??
				[...points].reverse().find((p) => p.ts <= startTs && slow(p)) ??
				[...points].reverse().find((p) => p.ts <= startTs);
			// Alight lookup: two reasons we need to be picky about which
			// post-train fix we use.
			//   1. Strict `>` (not `>=`): the fix AT endTs is still
			//      inside the train segment — the classifier closes a
			//      train segment on the first slow-enough fix, but that
			//      fix is mid-ride. `>=` picks it; `>` doesn't.
			//   2. Tighter speed threshold: between endTs and the actual
			//      disembark, a decelerating train through a non-
			//      disembark station can land a fix at 5-15 km/h. The
			//      looser POST_TRANSIT threshold accepts those and the
			//      alight resolves to "wherever the train is currently
			//      passing" rather than the actual disembark station.
			//      Fall back to the looser threshold if no fix below 5
			//      exists, then to any fix as final fallback.
			// Walk past mid-ride dwells: a slow fix followed within
			// MID_RIDE_DWELL_RESUME_S by a transit-speed fix is the
			// train pausing at a station, not the user getting off.
			// The actual alight is the first slow fix that ISN'T
			// followed by a return to transit speed.
			const findSustainedAlight = (predicate: (p: FilteredPoint) => boolean): FilteredPoint | undefined => {
				for (const p of points) {
					if (p.ts <= endTs) continue;
					if (!predicate(p)) continue;
					const cutoff = p.ts + MID_RIDE_DWELL_RESUME_S;
					const resumes = points.some((q) => q.ts > p.ts && q.ts <= cutoff && q.speed_kmh >= POST_TRANSIT_SPEED_KMH);
					if (!resumes) return p;
				}
				return undefined;
			};
			const alightFix =
				findSustainedAlight((p) => p.speed_kmh < POST_TRANSIT_ALIGHT_SPEED_KMH) ??
				findSustainedAlight((p) => slow(p)) ??
				points.find((p) => p.ts > endTs);
			const after = alightFix;
			if (!slowBefore || !after) return null;

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
			// user genuinely moved to a different station between the
			// stay and the boarding and we trust slowBefore's lookup
			// instead.
			let startStation: string | undefined;
			let beforeLookup = { lat: slowBefore.lat, lon: slowBefore.lon };
			let endStation: string | undefined;
			const BOARDING_NOISE_SPEED_KMH = 15;
			try {
				let stationaryCandidate: { name: string; lat: number; lon: number; endTs: number } | null = null;
				for (let i = run.from - 1; i >= 0; i--) {
					const seg = segments[i];
					if (seg.mode === "stationary") {
						// Strict `<` on the upper bound: seg.endTs equals the
						// next segment's startTs (the segment classifier puts
						// adjacent segments back-to-back). The fix at that
						// boundary is the FIRST fix of the next segment, not
						// the last of this one. Including it picks up the
						// mid-ride boundary fix as the "last stationary fix"
						// and the boarding-station lookup resolves to wherever
						// the train was passing, not the actual boarding
						// platform.
						const segPoints = points.filter((p) => p.ts >= seg.startTs && p.ts < seg.endTs);
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
					const dM = haversineMeters(stationaryCandidate.lat, stationaryCandidate.lon, slowBefore.lat, slowBefore.lon);
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
			// Two lines might both serve one endpoint but only one
			// reaches the other — the intersection picks the right line.
			// Append the suffix only
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
	//     The user thinks of it as one ride — "I got on at station A,
	//     off at station B" — not three sub-windows of the classifier
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
			// internally contradictory: mode=driving + a station-pair
			// wayName.
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

/** Longest stationary stretch (s) before a rail run still treated as a
 *  platform / concourse wait and absorbed into boarding the train. A
 *  longer stay at the station is left as its own state. */
const PLATFORM_WAIT_MAX_S = 15 * 60;

/**
 * Absorb a platform wait into the boarding of a rail run.
 *
 * A short stationary segment immediately before a `train` segment whose
 * location resolves to that train's boarding station is the wait on the
 * platform / concourse — part of catching the train, not a separate
 * stay. Left standalone it gets mislabelled: a station is not a focus
 * place, so the place-assigner snaps the stay to the nearest focus
 * place (e.g. a King's Cross platform wait surfaced as "@ Work" 380 m
 * away). Dropping the stationary and extending the train's start back
 * over it makes the timeline read walk → train.
 *
 * The boarding station is read from the train's station-pair wayName
 * (`"<board> → <alight>"`, optionally ` · <line>`), so this works for
 * both annotateRailRuns and annotateUndergroundRuns output.
 */
export async function absorbBoardingPlatform(
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]> = (lat, lon) =>
		dbOsmAdapter.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
): Promise<EnrichedSegment[]> {
	const absorbed = new Set<number>();
	const extendTo = new Map<number, number>();

	for (let k = 1; k < segments.length; k++) {
		const train = segments[k];
		if (train.mode !== "train") continue;
		const arrow = (train.wayName ?? "").indexOf(" → ");
		if (arrow < 0) continue;
		const boardingStation = (train.wayName ?? "").slice(0, arrow);

		const prev = segments[k - 1];
		if (prev.mode !== "stationary") continue;
		if (prev.endTs - prev.startTs > PLATFORM_WAIT_MAX_S) continue;

		const segPoints = points.filter((p) => p.ts >= prev.startTs && p.ts < prev.endTs);
		if (segPoints.length === 0) continue;
		const cLat = segPoints.reduce((a, p) => a + p.lat, 0) / segPoints.length;
		const cLon = segPoints.reduce((a, p) => a + p.lon, 0) / segPoints.length;
		const station = pickBestStation(await stationsLookup(cLat, cLon));
		if (!station || station.name !== boardingStation) continue;

		absorbed.add(k - 1);
		extendTo.set(k, prev.startTs);
	}

	if (absorbed.size === 0) return segments;
	const out: EnrichedSegment[] = [];
	for (let idx = 0; idx < segments.length; idx++) {
		if (absorbed.has(idx)) continue;
		const newStart = extendTo.get(idx);
		out.push(newStart !== undefined ? { ...segments[idx], startTs: newStart } : segments[idx]);
	}
	return out;
}

/** Longest a single stationary segment can be and still count as part
 *  of a transit interchange rather than a genuine stay. A platform-to-
 *  platform change or a wait for the next train runs minutes; a real
 *  stop is longer — and a real stay would also have coalesced with its
 *  neighbours in mergeAdjacentStays. */
const INTERCHANGE_SEGMENT_MAX_S = 8 * 60;

/** Longest a phantom drive-stop can be and still get absorbed. Real
 *  brief drive stops (drop-off, ATM, quick errand) tend to run a few
 *  minutes; longer stops are genuine and shouldn't be absorbed even if
 *  the user happened not to step out of the car. */
const DRIVE_STOP_ABSORB_MAX_S = 15 * 60;

/** Maximum steps accumulated inside a phantom drive-stop. Even briefly
 *  getting out of a car generates a handful of step counts; zero or near-
 *  zero is the biometric tell for "stayed in the vehicle the whole
 *  time". */
const DRIVE_STOP_ABSORB_MAX_STEPS = 5;

/**
 * Absorb a phantom drive-stop into the surrounding drives.
 *
 * A short `stationary` segment sandwiched between two `driving`
 * segments — when the biometric data shows zero / near-zero steps
 * across it — is a GPS-noise-driven phantom stop, not a real one.
 * Classic shape: dense-urban congestion or signal occlusion drops the
 * speed reading to zero, the classifier calls it stationary, and the
 * nearest typed OSM POI (in our motivating case, "The Lanesborough")
 * becomes the place label.
 *
 * If the user actually got out of the car, the watch records steps
 * almost immediately — even three steps from the seat to the kerb
 * appear. Zero steps over a 5–15 minute "stop" is the unambiguous
 * tell that the vehicle never opened its doors.
 *
 * Mirrors `absorbInterchanges` for the road case. Only fires when
 * the sandwich is `driving → short stationary → driving` — a stop at
 * the start or end of a day, or before a longer stay, is left alone.
 */
export function absorbDriveStops(segments: EnrichedSegment[], steps: readonly StepPoint[]): EnrichedSegment[] {
	const modeOf = (s: EnrichedSegment): string => s.refinedMode ?? s.mode;
	const stepsBetween = (startTs: number, endTs: number): number => {
		let total = 0;
		for (const p of steps) if (p.ts >= startTs && p.ts <= endTs) total += p.steps;
		return total;
	};
	const onePass = (input: EnrichedSegment[]): { out: EnrichedSegment[]; changed: boolean } => {
		const out: EnrichedSegment[] = [];
		let changed = false;
		let i = 0;
		while (i < input.length) {
			const seg = input[i];
			if (modeOf(seg) !== "driving" || i + 2 >= input.length) {
				out.push(seg);
				i++;
				continue;
			}
			const middle = input[i + 1];
			const next = input[i + 2];
			const isPhantomStop =
				modeOf(middle) === "stationary" &&
				modeOf(next) === "driving" &&
				middle.endTs - middle.startTs <= DRIVE_STOP_ABSORB_MAX_S &&
				stepsBetween(middle.startTs, middle.endTs) <= DRIVE_STOP_ABSORB_MAX_STEPS;
			if (isPhantomStop) {
				out.push({
					...seg,
					endTs: next.endTs,
					pointCount: seg.pointCount + middle.pointCount + next.pointCount,
				});
				i += 3;
				changed = true;
				continue;
			}
			out.push(seg);
			i++;
		}
		return { out, changed };
	};
	let current = segments;
	for (let guard = 0; guard < 10; guard++) {
		const { out, changed } = onePass(current);
		if (!changed) return out;
		current = out;
	}
	return current;
}

/**
 * Absorb a transit interchange into the train it follows.
 *
 * A run of short `stationary` segments immediately after a `train`
 * segment and followed by further movement is not a stay — it is the
 * interchange between trains: a platform-to-platform walk, a wait, or
 * an underground hop the classifier read as stationary because the
 * scattered fixes have little net displacement. Left alone each gets a
 * spurious place label — whatever OSM venue is nearest the noisy
 * underground centroid. This extends the preceding train over the run
 * and drops the run's segments, so the journey reads train → onward
 * with no phantom stop.
 *
 * Only fires for a run *between a train and another moving segment*. A
 * short stationary that ends the day, or that sits before a longer
 * stay, is left as a stay.
 */
export function absorbInterchanges(segments: EnrichedSegment[]): EnrichedSegment[] {
	const modeOf = (s: EnrichedSegment): string => s.refinedMode ?? s.mode;
	const out: EnrichedSegment[] = [];
	let i = 0;
	while (i < segments.length) {
		const seg = segments[i];
		if (modeOf(seg) !== "train") {
			out.push(seg);
			i++;
			continue;
		}
		// Collect the run of short stationary segments following the train.
		let runEnd = i + 1;
		while (
			runEnd < segments.length &&
			modeOf(segments[runEnd]) === "stationary" &&
			segments[runEnd].endTs - segments[runEnd].startTs <= INTERCHANGE_SEGMENT_MAX_S
		) {
			runEnd++;
		}
		// Absorb only when the run is non-empty AND the journey continues
		// past it with a moving segment — a run that ends the day, or is
		// stopped by a longer stationary stay, is not an interchange.
		const continues = runEnd < segments.length && modeOf(segments[runEnd]) !== "stationary";
		if (runEnd > i + 1 && continues) {
			out.push({ ...seg, endTs: segments[runEnd - 1].endTs });
			i = runEnd;
			continue;
		}
		out.push(seg);
		i++;
	}
	return out;
}

/** Separator between a rail run's two stations in a `wayName`. */
const RAIL_STATION_SEP = " → ";
/** Separator before the optional line-name suffix in a rail `wayName`. */
const RAIL_LINE_SEP = " · ";

/**
 * Parse a rail run's station-pair `wayName` — `"<board> → <alight>"`,
 * optionally followed by `" · <line>"`. Returns null when the string
 * is not a station-pair label (a road name, or absent).
 */
export function parseRailWayName(wayName: string | undefined): { board: string; alight: string; line?: string } | null {
	if (wayName === undefined) return null;
	const arrow = wayName.indexOf(RAIL_STATION_SEP);
	if (arrow < 0) return null;
	const board = wayName.slice(0, arrow);
	const rest = wayName.slice(arrow + RAIL_STATION_SEP.length);
	const dot = rest.indexOf(RAIL_LINE_SEP);
	if (dot < 0) return { board, alight: rest };
	return { board, alight: rest.slice(0, dot), line: rest.slice(dot + RAIL_LINE_SEP.length) };
}

/**
 * Physical constraint: two train legs that are back-to-back — adjacent
 * in the segment sequence with nothing between them — must share a
 * station. You cannot step off a train at one station and instantly be
 * on another train at a different station: there is no time and no
 * walk in between.
 *
 * `annotateRailRuns` and `annotateUndergroundRuns` resolve each leg's
 * boarding/alighting stations independently, so a leg reconstructed
 * from coarse underground fixes can land its boarding on a station the
 * previous leg already passed — a sequence that reads as travelling
 * backward. This pass enforces the constraint: where leg A's alighting
 * and leg B's boarding disagree, leg B is rewritten to board where
 * leg A alighted. Leg A's alighting is the trusted value — it is
 * established first, in time order, and a continuing journey picks up
 * from there.
 *
 * Only the station label is corrected; the split time and line name
 * are left as the upstream passes resolved them.
 */
export function reconcileAdjacentRailLegs(segments: EnrichedSegment[]): EnrichedSegment[] {
	const out = segments.map((s) => ({ ...s }));
	for (let i = 1; i < out.length; i++) {
		const a = out[i - 1];
		const b = out[i];
		if ((a.refinedMode ?? a.mode) !== "train" || (b.refinedMode ?? b.mode) !== "train") continue;
		const aRail = parseRailWayName(a.wayName);
		const bRail = parseRailWayName(b.wayName);
		if (aRail === null || bRail === null) continue;
		if (aRail.alight === bRail.board) continue;
		// Rewriting B's boarding to A's alighting would collapse leg B to
		// a single station — skip rather than emit a degenerate "X → X".
		if (aRail.alight === bRail.alight) continue;
		b.wayName = `${aRail.alight}${RAIL_STATION_SEP}${bRail.alight}${bRail.line ? `${RAIL_LINE_SEP}${bRail.line}` : ""}`;
	}
	return out;
}

/**
 * Attach a `snappedPath` to every train segment whose route is in the
 * precomputed cache.
 *
 * The snapped rail geometry is expensive to compute (a heavy OSM
 * spatial scan) so it is never computed on the request path. The
 * `refresh-rail-routes` CLI computes it offline and stores it in
 * `rail_route_cache`, keyed by the train run's `<board> → <alight>`
 * label. Here we do one indexed lookup, attach the geometry, and
 * interpolate the segment's time window along it. A train run whose
 * route is not yet cached simply keeps no `snappedPath` and the
 * frontend draws its raw fixes — it becomes snapped once the cron has
 * run. Purely additive: the raw track and day-state timeline are
 * untouched.
 */
export function annotateSnappedPaths(
	segments: EnrichedSegment[],
	railRouteCache: ReadonlyArray<{ routeKey: string; geometryJson: string }>,
): EnrichedSegment[] {
	const keys = new Set(
		segments.filter((s) => (s.refinedMode ?? s.mode) === "train" && s.wayName).map((s) => s.wayName as string),
	);
	if (keys.size === 0) return segments;

	const geomByKey = new Map<string, Array<{ lat: number; lon: number }>>();
	for (const r of railRouteCache) {
		if (!keys.has(r.routeKey)) continue;
		try {
			const geom = JSON.parse(r.geometryJson) as Array<{ lat: number; lon: number }>;
			if (Array.isArray(geom) && geom.length >= 2) geomByKey.set(r.routeKey, geom);
		} catch {
			// A malformed cache row is non-fatal — skip it; the run draws raw.
		}
	}
	if (geomByKey.size === 0) return segments;

	return segments.map((seg): EnrichedSegment => {
		if ((seg.refinedMode ?? seg.mode) !== "train" || !seg.wayName) return seg;
		const geom = geomByKey.get(seg.wayName);
		if (!geom) return seg;
		return { ...seg, snappedPath: interpolateTimes(geom, seg.startTs, seg.endTs) };
	});
}
