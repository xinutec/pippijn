/**
 * Factor framework — shared types for the scored-classification
 * refactor.
 *
 * See `docs/proposals/2026-05-scored-classification.md` for the
 * architectural context. Each factor is a pure function: given a
 * `ModeCandidate` (one of the alternative interpretations the
 * candidate-generator emitted) and a `FactorContext` (everything
 * the factor might look at — window features, segment biometrics,
 * OSM near-results, journey-pattern priors), it returns a
 * `FactorScore` carrying its name, a log-likelihood in nats, and a
 * short human-readable rationale.
 *
 * Returning `null` means "this factor does not apply to this
 * candidate / context" — the consumer drops it from the candidate's
 * score sum without penalty. Distinguishing null from a very
 * negative score matters: a missing biometric signature should not
 * dock score, only a clearly-disagreeing biometric signature should.
 */

import type { MinuteObservation, ModeStats } from "../mode-biometrics.js";
import type { TransportMode, WindowFeatures } from "../segments.js";

/** A single candidate interpretation of a segment. The candidate
 *  generator (rebuild of `refineMode` and `annotateRailRuns` in
 *  Phase 1) emits multiple candidates per segment; factors score
 *  them; the highest-total wins.
 *
 *  This shape will grow as factors that need more candidate-level
 *  detail get added (e.g. station-line-intersection wants both
 *  endpoint stations). Optional fields are added at the leaves; the
 *  base shape stays small. */
export interface ModeCandidate {
	mode: TransportMode;
	/** Free-form label for the way the candidate is "on" — typically
	 *  a road name, line name, or station-pair string. Optional
	 *  because some candidates (e.g. "stationary" without a known
	 *  amenity) don't carry one. */
	wayName?: string;
}

/** Everything a factor might want to consult. Each field is optional
 *  because most factors only need a few of them; the consumer fills
 *  in what's available and the factor returns null if its required
 *  inputs are missing. */
export interface FactorContext {
	/** Per-window scoring features (the inputs to the existing
	 *  Gaussian range-score in segments.ts). Required by the
	 *  speed-emission factor. */
	windowFeatures?: WindowFeatures;
	/** Aggregated per-segment biometric observation (hr/cadence/speed).
	 *  Required by the biometric-ll factor. */
	biometricObs?: MinuteObservation;
	/** Per-user per-mode biometric signatures from `mode_biometrics`.
	 *  Required by the biometric-ll factor; loaded once per call to
	 *  the consumer and passed unchanged through context. */
	modeStats?: ModeStats[];
}

export interface FactorScore {
	/** Stable identifier so the consumer can group/log/attribute
	 *  contributions. Matches the file name in the factors/ directory
	 *  by convention. */
	name: string;
	/** Log-likelihood in nats. Positive = candidate is consistent
	 *  with this factor's evidence; negative = inconsistent. The
	 *  sum across all factors for a candidate is the candidate's
	 *  total log-posterior, up to a normalising constant. */
	score: number;
	/** Human-readable explanation suitable for the Phase 3 UI
	 *  detail panel. Should describe *why* the factor scored this
	 *  way, not just the score value. */
	rationale: string;
}

/** A factor is a pure function. Async factors are not yet supported
 *  — if a factor needs DB or network data, the data should be
 *  pre-fetched and stuffed into `FactorContext` by the consumer. */
export type Factor = (candidate: ModeCandidate, ctx: FactorContext) => FactorScore | null;
