/**
 * Presence-continuity emission factor — Phase 3 of
 * `docs/proposals/2026-06-presence-continuity.md`.
 *
 * Pure module. Computes a log-likelihood contribution for a per-minute
 * observation, given the HSMM state hypothesis and a continuity
 * context (the prior day's end-of-day place + how stale that signal
 * is). The factor:
 *
 *   - is silent when `priorPlaceId` is null (no continuation signal)
 *   - is silent when the state's placeId doesn't match priorPlaceId
 *   - is silent when the observation has a GPS fix (the existing
 *     place-distance Gaussian handles it; this factor only fires under
 *     no-fix evidence)
 *   - otherwise returns a positive log-bonus = log(BASELINE) +
 *     log(decay) + log(priorPosterior) — three factors combining to
 *     pull the HSMM toward the continuation candidate when nothing
 *     contradicts it.
 *
 * The baseline + tau values are the design defaults (Phase 2
 * empirical calibration is deferred — see the proposal's Phasing
 * section). Both are kept as module constants so a future calibration
 * pass can tune them in one place.
 */

import type { Observation } from "../observation.js";
import type { State } from "../state-space.js";

export interface ContinuityContext {
	/** focus_places.id from the prior day's end-of-day state, or null
	 *  when the prior day had no established stay (a travel day). */
	priorPlaceId: number | null;
	/** Hours elapsed between the prior day's last confirmed GPS fix
	 *  and the minute being scored. Drives the time-decay term. */
	hoursSinceLastConfirmedFix: number;
	/** Posterior the HSMM assigned to the prior day's end-of-day
	 *  state (0–1). Carried forward unchanged so a high-confidence
	 *  seed contributes more than a low-confidence one. */
	priorPosterior: number;
}

/** P(no-fix-minute | inside-established-stay) — the design default.
 *  Reflects that even with Owntracks on, a sit-at-known-place minute
 *  often lacks a fix (indoor multipath, batched sends, save-power
 *  modes). Phase 2 will calibrate this empirically per-user. */
const BASELINE_NOFIX_LIKELIHOOD = 0.5;

/** Time decay constant (hours). At `tau` hours of no fresh fix the
 *  continuation's contribution drops to 1/e ≈ 0.37 of its baseline.
 *  At 2·tau ≈ 14%; at 3·tau ≈ 5%. */
const TAU_HOURS = 24;

/** Log-likelihood contribution from the presence-continuity factor.
 *  Pure function; both inputs are read-only. */
export function continuityLogLikelihood(state: State, obs: Observation, ctx: ContinuityContext | null): number {
	if (ctx === null) return 0;
	if (ctx.priorPlaceId === null) return 0;
	if (state.mode !== "stationary") return 0;
	if (state.placeId !== ctx.priorPlaceId) return 0;
	if (obs.gps !== null) return 0; // place-distance factor handles fix-present minutes
	const decay = Math.exp(-Math.max(0, ctx.hoursSinceLastConfirmedFix) / TAU_HOURS);
	const product = BASELINE_NOFIX_LIKELIHOOD * decay * Math.max(0, Math.min(1, ctx.priorPosterior));
	if (product <= 0) return 0;
	return Math.log(product);
}
