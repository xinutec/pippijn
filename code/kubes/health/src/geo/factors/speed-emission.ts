/**
 * speed-emission factor.
 *
 * Wraps the existing `scoreWindow` Gaussian range-score in
 * `segments.ts` as a log-likelihood per `ModeCandidate`. The factor
 * unpacks an existing computation; it does not introduce new logic.
 * That's by design — Phase 1 of the scored-classification refactor
 * (see `docs/proposals/2026-05-scored-classification.md`) is
 * structural, not behavioural.
 *
 * Behavioural notes:
 *
 * - `scoreWindow` returns multiplicative masses (positive numbers,
 *   typically in [0, ~10]). We log-transform to get nats, so the
 *   factor's contribution is additive in the per-candidate sum.
 *
 * - Returns null when no `windowFeatures` are in the context. This
 *   distinguishes "factor doesn't apply" from "factor strongly
 *   disagrees" (-Infinity).
 *
 * - When `scoreWindow` returns 0 for a candidate (one of the
 *   product-form multipliers zeroed it), we log to `-Infinity`. The
 *   consumer treats that as "this candidate is ruled out" — it's
 *   the right behaviour, not a special case.
 */

import { scoreWindow } from "../segments.js";
import type { Factor } from "./types.js";

export const speedEmission: Factor = (candidate, ctx) => {
	if (!ctx.windowFeatures) return null;
	const scores = scoreWindow(ctx.windowFeatures);
	const match = scores.find((s) => s.mode === candidate.mode);
	if (!match) return null; // unknown mode — should not happen with TransportMode-typed candidates
	const score = match.score > 0 ? Math.log(match.score) : Number.NEGATIVE_INFINITY;
	return {
		name: "speed-emission",
		score,
		rationale: rationaleFor(candidate.mode, ctx.windowFeatures.medianSpeed, score),
	};
};

function rationaleFor(mode: string, medianSpeedKmh: number, score: number): string {
	if (score === Number.NEGATIVE_INFINITY) {
		return `speed/linearity profile rules out ${mode}`;
	}
	if (score >= 0) {
		return `speed/linearity profile consistent with ${mode} at ${medianSpeedKmh.toFixed(1)} km/h`;
	}
	return `speed/linearity profile partially fits ${mode} at ${medianSpeedKmh.toFixed(1)} km/h`;
}
