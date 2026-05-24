/**
 * Static-prior transition log-probabilities for the MVP HMM.
 *
 * The full HMM design (`docs/archive/2025-model-hmm.md`) learns
 * transitions from heuristic-pipeline bootstrap labels with Dirichlet
 * smoothing. For the MVP we use a hand-tuned rule-based prior — it
 * captures the structural truths without the bootstrap-bias risk
 * of learning from biased labels.
 *
 * Calibration:
 *   - Self-loops: log(0.95) ≈ -0.05. The HMM stays in a state
 *     minute-to-minute most of the time. Strong self-bias is the
 *     "Station B" mechanism: when emission is ambiguous, the
 *     self-loop pulls the path through.
 *   - Mode changes (e.g. stationary → walking): log(0.02). Common
 *     enough to fire when emission supports them.
 *   - Hard-zero rules — structural impossibilities:
 *     - stationary @ A → stationary @ B (different non-null places):
 *       impossible. Must pass through a moving state.
 *
 * Station-graph hard-zeros (train @ L cannot serve a place not on
 * line L) are wired at integration time, not here — they require
 * the per-place coordinates that this pure module doesn't know
 * about.
 *
 * Learned transitions and time-of-day conditioning are post-MVP.
 * The "rows sum to ≤ 1" test pins that the matrix is a proper
 * probability distribution even with hard-zeros.
 */

import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

export type TransitionLogProbFn = (from: State, to: State, toObs: Observation) => number;

export interface BuildTransitionMatrixOpts {
	states: readonly State[];
	/** Self-loop log-probability. Default log(0.95). */
	selfLoopLogProb?: number;
	/** Station-graph hard-zero lookup: returns `true` when the given
	 *  focus_place is within walking distance of a station served by
	 *  the named rail line. When provided, transitions between
	 *  `train @ L` and `stationary @ P` (in either direction) are
	 *  hard-zeroed when `placeNearLine(P, L) === false`. */
	placeNearLine?: (placeId: number, lineName: string) => boolean;
	/** Per-place hour-of-day visit profile, 24 normalised buckets
	 *  summing to 1. When provided, transitions INTO `stationary @ P`
	 *  (from any different state) gain an additive log-prior of
	 *  `log(24 × profile_P[hour])`, clamped to ±`entryBoostClamp`.
	 *
	 *  This is the "entry boost" formulation of the time-of-day prior:
	 *  it fires only at the moment of transition (when the HMM picks
	 *  WHICH state to enter), not per-minute over the stay (which
	 *  would accumulate into a hundreds-of-nats bias for whichever
	 *  place's profile peaks during a long GPS-null stretch — Phase
	 *  1.7 audit). Once in a state, self-loop is free of this term. */
	placeHourProfiles?: ReadonlyMap<number, readonly number[]>;
	/** Magnitude clamp on the entry boost. Default 0.5 nats. */
	entryBoostClamp?: number;
}

const HOUR_PROFILE_FLOOR = 0.001;
const DEFAULT_ENTRY_BOOST_CLAMP = 0.5;

const DEFAULT_SELF_LOOP = Math.log(0.95);

function sameState(a: State, b: State): boolean {
	return a.mode === b.mode && a.placeId === b.placeId && a.lineName === b.lineName;
}

/**
 * Build a transition log-prob function over the given state space.
 *
 * Per-row normalised: for each `from` state, the self-loop holds
 * `exp(selfLoopLogProb)` of the probability mass, and the remaining
 * `1 - exp(selfLoopLogProb)` is split equally among the valid
 * (non-hard-zero) cross-state destinations. This keeps the matrix
 * a proper row-stochastic distribution regardless of state count
 * or how many hard-zeros apply to each row.
 */
export function buildTransitionMatrix(opts: BuildTransitionMatrixOpts): TransitionLogProbFn {
	const selfLoop = opts.selfLoopLogProb ?? DEFAULT_SELF_LOOP;
	const crossMass = 1 - Math.exp(selfLoop);
	const placeNearLine = opts.placeNearLine ?? null;
	const hourProfiles = opts.placeHourProfiles ?? null;
	const entryClamp = opts.entryBoostClamp ?? DEFAULT_ENTRY_BOOST_CLAMP;

	const isHardZeroFn = (from: State, to: State): boolean => isHardZero(from, to, placeNearLine);

	// Pre-compute the per-row cross-state log-prob: for each from-state,
	// count the valid cross destinations and divide the cross mass.
	// O(S²) once, then O(1) per query.
	const crossLogByFrom = new Map<string, number>();
	for (const from of opts.states) {
		let validCrossCount = 0;
		for (const to of opts.states) {
			if (sameState(from, to)) continue;
			if (isHardZeroFn(from, to)) continue;
			validCrossCount++;
		}
		const fromKey = stateInternalKey(from);
		if (validCrossCount > 0) {
			crossLogByFrom.set(fromKey, Math.log(crossMass / validCrossCount));
		} else {
			crossLogByFrom.set(fromKey, Number.NEGATIVE_INFINITY);
		}
	}

	// Pre-compute the entry boost per (placeId, hour) — fires only when
	// transitioning INTO stationary @ placeId from a different state.
	// Time-of-day boost: log(24 × profile[h]), floored and clamped.
	function entryBoost(toState: State, toObs: Observation): number {
		if (hourProfiles === null) return 0;
		if (toState.mode !== "stationary" || toState.placeId === null) return 0;
		const profile = hourProfiles.get(toState.placeId);
		if (profile === undefined || profile.length !== 24) return 0;
		const f = Math.max(profile[toObs.hourLocal], HOUR_PROFILE_FLOOR);
		const raw = Math.log(24 * f);
		return Math.max(-entryClamp, Math.min(entryClamp, raw));
	}

	return (from: State, to: State, toObs: Observation): number => {
		if (sameState(from, to)) return selfLoop;
		if (isHardZeroFn(from, to)) return Number.NEGATIVE_INFINITY;
		const baseLog = crossLogByFrom.get(stateInternalKey(from)) ?? Number.NEGATIVE_INFINITY;
		if (baseLog === Number.NEGATIVE_INFINITY) return baseLog;
		return baseLog + entryBoost(to, toObs);
	};
}

function isHardZero(
	from: State,
	to: State,
	placeNearLine: ((placeId: number, lineName: string) => boolean) | null,
): boolean {
	// Hard-zero: stationary @ A → stationary @ B with A ≠ B (whether
	// or not either side is a known place). The user can't teleport
	// between two stationary places without a moving state in
	// between. Includes the asymmetric case where one side is null
	// (off-network) — same principle, the user must move to get
	// there even if "there" is unobservable.
	if (from.mode === "stationary" && to.mode === "stationary" && from.placeId !== to.placeId) {
		return true;
	}

	// Station-graph hard-zero: a train on line L cannot alight at
	// place P if L doesn't serve any station near P, and (symmetric)
	// a stationary at P cannot board a train on L if L doesn't serve
	// P. Only fires when placeNearLine lookup is provided and the
	// line is a named line (not the unknown_rail catch-all).
	if (placeNearLine !== null) {
		if (
			from.mode === "train" &&
			to.mode === "stationary" &&
			to.placeId !== null &&
			from.lineName !== null &&
			from.lineName !== "unknown_rail"
		) {
			if (!placeNearLine(to.placeId, from.lineName)) return true;
		}
		if (
			from.mode === "stationary" &&
			to.mode === "train" &&
			from.placeId !== null &&
			to.lineName !== null &&
			to.lineName !== "unknown_rail"
		) {
			if (!placeNearLine(from.placeId, to.lineName)) return true;
		}
	}

	return false;
}

function stateInternalKey(s: State): string {
	return `${s.mode}|${s.placeId ?? "-"}|${s.lineName ?? "-"}`;
}
