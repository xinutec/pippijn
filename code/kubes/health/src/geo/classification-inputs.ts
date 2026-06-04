/**
 * `ClassificationInputs` — the closure of inputs to the classification
 * pipeline for one (user, date).
 *
 * Phase 1 of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * The pipeline currently reads from a DB and the PhoneTrack HTTP API
 * at call time. That makes goldens non-deterministic: any of those
 * external states can drift between bless and check. The remedy is
 * to plumb every external read through a single typed value, so the
 * pipeline becomes `inputs → output` with no side fetches.
 *
 * Production loads this from the DB via `loadClassificationInputs`.
 * Tests load it from a captured fixture. Same pipeline, same value
 * shape, two sources.
 *
 * Phase 1 covers the eager loads that happen at the top of
 * `computeVelocity`:
 *
 *   - PhoneTrack fixes (three windows: today, next morning, prev evening)
 *   - Known places (focus_places projection used by snap)
 *   - Biometrics (HR, sleep, steps)
 *   - Per-user mode biometric signatures
 *
 * Later phases will add the lazy loads (OSM mirror, decoded_days,
 * rail_route_cache, presence_log) so the closure becomes complete.
 * The type evolves additively; callers consuming Phase 1 fields keep
 * working.
 */

import type { HmmSegment } from "../hmm/persist.js";
import type { HrPoint, SleepStageRecord, StepPoint } from "./biometrics.js";
import type { ModeStats } from "./mode-biometrics.js";
import type { OsmSnapshot } from "./osm-pure.js";
import type { KnownPlace } from "./place-snap.js";

/** A PhoneTrack fix as returned by `fetchTrackPointsRange`. Mirrors
 *  the prod loader's projection — we never strip fields between the
 *  loader and the pipeline. */
export interface RawPhonetrackFix {
	ts: number;
	lat: number;
	lon: number;
	altitude: number | null;
	speed: number | null;
	accuracy: number | null;
	battery: number | null;
}

/** A user's known cluster as the pipeline reads it. Extends
 *  `KnownPlace` (the geometry contract `snapToPlace` consumes) with
 *  the metadata the place picker, HSMM, and refineMode all use. Same
 *  shape currently called `NamedPlace` inside `velocity.ts` — that
 *  declaration will migrate to this one in a later phase. */
export interface KnownPlaceProjection extends KnownPlace {
	displayName: string | null;
	sleepHours: number;
	amenityLabel: string | null;
	uniqueDays: number;
	hourProfile: number[] | null;
}

/** Identity portion: which day, in which timezone, for which user.
 *  Pulled out so it can be referenced before any input is loaded. */
export interface DayIdentity {
	userId: string;
	/** Local date string `YYYY-MM-DD` in `displayTz`. */
	date: string;
	/** IANA timezone — drives all local-clock derivations. */
	displayTz: string;
}

/** The three PhoneTrack windows the pipeline fetches at the top of
 *  `computeVelocity`. Same three calls, captured eagerly so tests
 *  don't open the HTTP connection. */
export interface PhonetrackWindows {
	/** Local-day fixes: `[date 00:00 local, next-day 00:00 local)`. */
	today: RawPhonetrackFix[];
	/** Next morning fixes (UTC midnight to next-day 12:00 UTC).
	 *  Feeds sleep-place attribution when sleep crosses midnight. */
	morning: RawPhonetrackFix[];
	/** Prior evening fixes (prev-day 12:00 UTC to date 00:00 UTC).
	 *  Feeds sleep-place when evening sleep started yesterday. */
	priorEvening: RawPhonetrackFix[];
}

export interface BiometricsSnapshot {
	hr: HrPoint[];
	sleep: SleepStageRecord[];
	steps: StepPoint[];
}

/**
 * The classification pipeline's input closure. Evolves additively as
 * later phases lift their external reads into named fields.
 *
 * Phases landed so far:
 *   - Phase 1 / 2a: eager DB+HTTP loads (PhoneTrack, focus_places,
 *     biometrics, mode_biometrics) consolidated through this value.
 *   - Phase 4: `decoded_days[date]` for the HSMM place override.
 *
 * Remaining external reads (still go to the DB at request time;
 * to be lifted in later phases):
 *   - OSM (`nearbyWays`, `nearbyStations`, `ensureCovered`)
 *   - `rail_route_cache` for train-segment snapped paths
 *   - `presence_log[date-1]` (HSMM-only, decode-day Phase 7)
 */
export interface ClassificationInputs {
	identity: DayIdentity;
	phonetrack: PhonetrackWindows;
	knownPlaces: KnownPlaceProjection[];
	biometrics: BiometricsSnapshot;
	modeBiometrics: ModeStats[];
	/** HSMM-decoded segments for this day from `decoded_days`, or
	 *  null when no decode exists yet (cron hasn't run, or the day
	 *  is too old / new for the rolling window). The velocity layer
	 *  reads this to override stationary-segment placeId attribution
	 *  with the HSMM's pick. Phase 4 of
	 *  `docs/proposals/2026-06-deterministic-fixtures.md`. */
	hsmmDecode: HmmSegment[] | null;
	/** Pre-computed rail-line geometries keyed by `<board> → <alight>`
	 *  string. `annotateSnappedPaths` looks up each train segment's
	 *  `wayName` against this set to attach a `snappedPath`. The cache
	 *  is global (not user-scoped) and small enough to load in full
	 *  for the day. Phase 5 of the deterministic-fixtures proposal. */
	railRouteCache: RailRouteEntry[];
	/** All `osm_lines` / `osm_points` rows within the day's PhoneTrack
	 *  bbox (plus a buffer), parsed once. The pure spatial helpers in
	 *  `osm-pure.ts` filter this by feature_type and distance. Pre-
	 *  fetched at the boundary so the request path runs no OSM queries.
	 *  Phase 6 of the deterministic-fixtures proposal. */
	osm: OsmSnapshot;
}

/** A single `rail_route_cache` row, projected to the columns
 *  `annotateSnappedPaths` reads. */
export interface RailRouteEntry {
	routeKey: string;
	/** WKT-free JSON encoding of the route polyline: an array of
	 *  `{lat, lon}` objects. Same shape `annotateSnappedPaths` parses
	 *  out of `geometry_json` today. */
	geometryJson: string;
}
