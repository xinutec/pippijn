/**
 * `buildInitialStatePrior` — initial-state log-prior for Viterbi.
 *
 * Tests pin:
 *   - With no weights provided, returns a uniform 0 prior.
 *   - With weights, stationary @ heavy-visit places get positive
 *     log-priors; rarely-visited places get negative ones.
 *   - Non-stationary states (movement, train) get 0 (not penalised).
 *   - Off-network stationary (placeId = null) gets 0.
 *   - Missing placeId in the weights map falls back to a small
 *     fraction (not -Infinity).
 */

import { describe, expect, it } from "vitest";
import { buildInitialStatePrior } from "../src/hmm/initial-state.js";
import type { State } from "../src/hmm/state-space.js";

function state(mode: State["mode"], placeId: number | null = null, lineName: string | null = null): State {
	return { mode, placeId, lineName };
}

describe("buildInitialStatePrior", () => {
	it("returns uniform 0 when no weights provided", () => {
		const prior = buildInitialStatePrior({});
		expect(prior(state("stationary", 1))).toBe(0);
		expect(prior(state("walking"))).toBe(0);
		expect(prior(state("train", null, "Metropolitan Line"))).toBe(0);
	});

	it("returns uniform 0 when weights map is empty", () => {
		const prior = buildInitialStatePrior({ placeVisitWeights: new Map() });
		expect(prior(state("stationary", 1))).toBe(0);
	});

	it("favours heavy-visit places over rare ones", () => {
		const weights = new Map([
			[1, 0.5], // Home — 50% of dwell
			[2, 0.05], // Café — 5%
			[3, 0.01], // Clinic — 1%
		]);
		const prior = buildInitialStatePrior({ placeVisitWeights: weights });
		const homeScore = prior(state("stationary", 1));
		const cafeScore = prior(state("stationary", 2));
		const clinicScore = prior(state("stationary", 3));
		expect(homeScore).toBeGreaterThan(cafeScore);
		expect(cafeScore).toBeGreaterThan(clinicScore);
	});

	it("computes log(N × weight) for known places", () => {
		const weights = new Map([
			[1, 0.5],
			[2, 0.5],
		]);
		const prior = buildInitialStatePrior({ placeVisitWeights: weights });
		// nPlaces = 2, weight = 0.5 → log(2 × 0.5) = log(1) = 0
		expect(prior(state("stationary", 1))).toBeCloseTo(0, 5);
	});

	it("gives 0 to movement modes (not penalised)", () => {
		const weights = new Map([[1, 0.5]]);
		const prior = buildInitialStatePrior({ placeVisitWeights: weights });
		expect(prior(state("walking"))).toBe(0);
		expect(prior(state("cycling"))).toBe(0);
		expect(prior(state("driving"))).toBe(0);
		expect(prior(state("plane"))).toBe(0);
		expect(prior(state("train", null, "Metropolitan Line"))).toBe(0);
	});

	it("gives 0 to off-network stationary (placeId = null)", () => {
		const weights = new Map([[1, 0.5]]);
		const prior = buildInitialStatePrior({ placeVisitWeights: weights });
		expect(prior(state("stationary", null))).toBe(0);
	});

	it("falls back to a small fraction (not -Infinity) for unknown placeId", () => {
		const weights = new Map([[1, 0.5]]);
		const prior = buildInitialStatePrior({ placeVisitWeights: weights });
		const score = prior(state("stationary", 999));
		expect(Number.isFinite(score)).toBe(true);
	});

	it("typical Home-vs-rare delta is several nats — enough to win at t=0", () => {
		// Realistic 22-place user: Home holds 50%, a rare clinic holds
		// 0.5%. The delta should be ~4-5 nats — more than the cost of
		// the emission delta on a GPS-null minute, so Home wins at t=0.
		const weights = new Map<number, number>();
		weights.set(1, 0.5);
		for (let i = 2; i <= 22; i++) weights.set(i, 0.025);
		const prior = buildInitialStatePrior({ placeVisitWeights: weights });
		const homeScore = prior(state("stationary", 1));
		const otherScore = prior(state("stationary", 2));
		expect(homeScore - otherScore).toBeGreaterThan(2);
	});
});
