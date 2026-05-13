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
	// Preferred path: full WindowFeatures available (from segments
	// pipeline). Use the rich Gaussian range-score per mode.
	if (ctx.windowFeatures) {
		const scores = scoreWindow(ctx.windowFeatures);
		const match = scores.find((s) => s.mode === candidate.mode);
		if (!match) return null;
		const score = match.score > 0 ? Math.log(match.score) : Number.NEGATIVE_INFINITY;
		return {
			name: "speed-emission",
			score,
			rationale: rationaleFor(candidate.mode, ctx.windowFeatures.medianSpeed, score),
		};
	}
	// Fallback path: only `speedKmh` is available (e.g. refineMode
	// called with a segment-aggregated speed; WindowFeatures lives
	// upstream). Coarser per-mode rules — enough to discriminate
	// walking-pace from vehicular and to keep walking from winning
	// on a fast urban segment.
	if (ctx.speedKmh !== undefined) {
		const score = scoreFromSpeedOnly(candidate.mode, ctx.speedKmh);
		if (score === null) return null;
		return {
			name: "speed-emission",
			score,
			rationale: `(speed-only) ${candidate.mode} at ${ctx.speedKmh.toFixed(1)} km/h`,
		};
	}
	return null;
};

/** Coarser per-mode log-likelihood from speed alone. Values are
 *  tuned so the factor produces roughly the same per-mode ranking
 *  as scoreWindow on synthetic features at the same median speed,
 *  but linearity / heading-change / bounding-radius signals are
 *  absent. Mid-range scores (~0 nats) reflect "neutral — speed
 *  alone is consistent with this mode"; large negatives are clear
 *  exclusions (walking at 60 km/h, train at 5 km/h). */
function scoreFromSpeedOnly(mode: string, kmh: number): number | null {
	switch (mode) {
		case "stationary":
			return kmh < 2 ? 0.5 : kmh < 8 ? -0.5 : -2.5;
		case "walking":
			if (kmh > 15) return -3.0;
			if (kmh >= 2 && kmh <= 8) return 0.5;
			return -0.5;
		case "cycling":
			if (kmh >= 10 && kmh <= 28) return 0.5;
			if (kmh > 40) return -2.0;
			return -0.5;
		case "driving":
			if (kmh > 25) return 1.0;
			if (kmh > 15) return 0.3;
			if (kmh > 8) return -0.5;
			// Walking-pace or slower: strongly contradicts driving.
			// Mirrors the segments.ts scoreDriving multiplier 0.1× for
			// medianSpeed < 10 (≈ -2.3 nats in log domain).
			return -2.5;
		case "train":
			if (kmh > 40) return 1.0;
			if (kmh < 10) return -2.5;
			return 0;
		case "plane":
			if (kmh > 200) return 1.5;
			if (kmh < 80) return -3.0;
			return 0;
		default:
			return null;
	}
}

function rationaleFor(mode: string, medianSpeedKmh: number, score: number): string {
	if (score === Number.NEGATIVE_INFINITY) {
		return `speed/linearity profile rules out ${mode}`;
	}
	if (score >= 0) {
		return `speed/linearity profile consistent with ${mode} at ${medianSpeedKmh.toFixed(1)} km/h`;
	}
	return `speed/linearity profile partially fits ${mode} at ${medianSpeedKmh.toFixed(1)} km/h`;
}
