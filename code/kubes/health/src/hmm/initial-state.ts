/**
 * Initial-state log-prior for the Viterbi decoder.
 *
 * The Viterbi decoder accepts an optional `initialLogProb(state)`
 * callback that scores each state at t=0 before the first emission
 * is added. Default is uniform (all states tied) — this module
 * returns a richer prior based on per-place visit frequency so the
 * HMM doesn't have to "learn" overnight that the user is most
 * likely at Home.
 *
 * Why initial-state, not per-minute emission:
 *
 *   A per-minute "this user is usually at Home" bias accumulates
 *   over 500+ GPS-null overnight minutes into hundreds of nats of
 *   Home-pressure, which then dominates mid-day visits (e.g. a
 *   clinic) where the user is clearly elsewhere — visible in the
 *   Phase 1.7 audit as the HMM leaving Cleveland Clinic mid-stay
 *   to "walk home" because the cumulative Home prior outweighed
 *   the local evidence.
 *
 *   Moving the bias to t=0 only is the structurally correct fix.
 *   Self-loops (log(0.95) per minute) maintain continuity once a
 *   state is selected, so the t=0 nudge persists through the night
 *   without applying any per-minute pressure that could displace
 *   a different daytime stay.
 *
 * Pure function. No DB, no IO, no globals.
 */

import type { State } from "./state-space.js";

export type InitialLogProbFn = (state: State) => number;

export interface BuildInitialStatePriorOpts {
	/** Per-place visit-frequency weight — fraction of total stationary
	 *  time at each known place. Typically
	 *  `focus_places.total_dwell_sec / sum_over_all_places`. When
	 *  present, `stationary @ placeId` states at t=0 get a log-prior
	 *  of `log(N_places × weight)`. A ~60%-of-time Home with 144
	 *  places: +4.5 nats. A 1% place: -0.4 nats.
	 *
	 *  Other states (movement, off-network stationary, train) get a
	 *  log-prior of 0 — they're not penalised, just not boosted. The
	 *  HMM can still start in walking if the first minute's emission
	 *  strongly favours walking. */
	placeVisitWeights?: ReadonlyMap<number, number>;
}

export function buildInitialStatePrior(opts: BuildInitialStatePriorOpts = {}): InitialLogProbFn {
	const visitWeights = opts.placeVisitWeights ?? null;
	const nPlaces = visitWeights !== null ? visitWeights.size : 0;
	if (visitWeights === null || nPlaces === 0) {
		return (): number => 0;
	}
	return (state: State): number => {
		if (state.mode !== "stationary" || state.placeId === null) return 0;
		const w = visitWeights.get(state.placeId) ?? 1 / (10 * nPlaces);
		return Math.log(nPlaces * w);
	};
}
