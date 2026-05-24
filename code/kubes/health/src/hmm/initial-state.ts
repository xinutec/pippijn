/**
 * Initial-state log-prior for the MVP HMM.
 *
 * The Viterbi decoder accepts an optional `initialLogProb(state)`
 * callback that scores each state at t=0 before the first emission
 * is added. By default the decoder uses a uniform prior (all states
 * tied) — this module returns a richer prior based on per-place
 * visit frequency so the HMM doesn't have to "learn" overnight that
 * the user is most likely at Home.
 *
 * Why initial-state, not per-minute emission:
 *
 *   The Phase 1.6 audit moved visit-frequency into the per-minute
 *   emission as a tie-breaker when GPS was null. That worked for
 *   overnight (Home wins t=0..09:00) but broke the all-day Cleveland
 *   Clinic visit. A +1 nat/min bias for Home accumulates to +60 nats
 *   over an hour-long stay — easily overcoming the ~12-nat cost of
 *   a fake "walking" detour that lets the HMM pretend to be at Home.
 *   Result: HMM left Cleveland mid-visit and "walked" to Home.
 *
 *   Moving the bias to t=0 only is the structurally correct fix:
 *   self-loops (log(0.95) per minute) maintain continuity once a
 *   state is selected, so the t=0 nudge persists through the night
 *   without applying any per-minute pressure that could displace
 *   a different daytime stay.
 *
 * Pure function. No DB, no I/O, no globals.
 */

import type { State } from "./state-space.js";

export type InitialLogProbFn = (state: State) => number;

export interface BuildInitialStatePriorOpts {
	/** Per-place visit-frequency weight — fraction of total stationary
	 *  time at each known place. Typically `focus_places.total_dwell_sec
	 *  / sum_over_all_places`. When present, `stationary @ placeId`
	 *  states at t=0 get a log-prior of `log(N_places × weight)`. A
	 *  ~50%-of-time Home with 11 places: +1.7 nats. A 1% place: -2.2
	 *  nats.
	 *
	 *  Other states (movement, off-network stationary, train) get a
	 *  log-prior of 0 — they're not penalised, just not boosted. This
	 *  way the HMM can still start in walking if the first minute
	 *  emits walking strongly. */
	placeVisitWeights?: ReadonlyMap<number, number>;
}

/**
 * Build an initial-state log-prior function for the Viterbi decoder.
 *
 * The returned function maps a state to its t=0 log-prior. The
 * decoder will combine this with the emission at t=0 to score each
 * starting state.
 */
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
