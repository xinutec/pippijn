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

import type { State } from "./state-space.js";

export type TransitionLogProbFn = (from: State, to: State) => number;

export interface BuildTransitionMatrixOpts {
	states: readonly State[];
	/** Self-loop log-probability. Default log(0.95). */
	selfLoopLogProb?: number;
	/** Generic cross-state log-prob (when no specific rule applies).
	 *  Default log(0.02). */
	crossStateLogProb?: number;
}

const DEFAULT_SELF_LOOP = Math.log(0.95);
const DEFAULT_CROSS_STATE = Math.log(0.02);

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
 *
 * `crossStateLogProb` is unused under the new normalisation but kept
 * in the options for API stability — future per-pair priors (e.g.
 * common vs rare transitions) will plug in here.
 */
export function buildTransitionMatrix(opts: BuildTransitionMatrixOpts): TransitionLogProbFn {
	const selfLoop = opts.selfLoopLogProb ?? DEFAULT_SELF_LOOP;
	const crossMass = 1 - Math.exp(selfLoop);

	// Pre-compute the per-row cross-state log-prob: for each from-state,
	// count the valid cross destinations and divide the cross mass.
	// O(S²) once, then O(1) per query.
	const crossLogByFrom = new Map<string, number>();
	for (const from of opts.states) {
		let validCrossCount = 0;
		for (const to of opts.states) {
			if (sameState(from, to)) continue;
			if (isHardZero(from, to)) continue;
			validCrossCount++;
		}
		const fromKey = stateInternalKey(from);
		if (validCrossCount > 0) {
			crossLogByFrom.set(fromKey, Math.log(crossMass / validCrossCount));
		} else {
			// No valid cross destinations — self-loop is the only option.
			// (Shouldn't happen in practice; defensive.)
			crossLogByFrom.set(fromKey, Number.NEGATIVE_INFINITY);
		}
	}

	return (from: State, to: State): number => {
		if (sameState(from, to)) return selfLoop;
		if (isHardZero(from, to)) return Number.NEGATIVE_INFINITY;
		return crossLogByFrom.get(stateInternalKey(from)) ?? Number.NEGATIVE_INFINITY;
	};
}

function isHardZero(from: State, to: State): boolean {
	// Hard-zero: stationary @ A → stationary @ B with A ≠ B (whether
	// or not either side is a known place). The user can't teleport
	// between two stationary places without a moving state in
	// between. Includes the asymmetric case where one side is null
	// (off-network) — same principle, the user must move to get
	// there even if "there" is unobservable.
	if (from.mode === "stationary" && to.mode === "stationary" && from.placeId !== to.placeId) {
		return true;
	}
	return false;
}

function stateInternalKey(s: State): string {
	return `${s.mode}|${s.placeId ?? "-"}|${s.lineName ?? "-"}`;
}
