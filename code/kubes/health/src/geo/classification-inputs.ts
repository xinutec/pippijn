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

import type { HrPoint, SleepStageRecord, StepPoint } from "./biometrics.js";
import type { ModeStats } from "./mode-biometrics.js";
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
 * The Phase 1 input closure. Fields are added in later phases;
 * callers consuming this shape today keep working when new fields
 * land (additive evolution).
 */
export interface ClassificationInputs {
	identity: DayIdentity;
	phonetrack: PhonetrackWindows;
	knownPlaces: KnownPlaceProjection[];
	biometrics: BiometricsSnapshot;
	modeBiometrics: ModeStats[];
}
