/**
 * `buildInitialStatePrior` — initial-state log-prior for Viterbi.
 *
 * Tests pin:
 *   - Uniform 0 when no weights provided.
 *   - Stationary @ known-place gets log(N × weight).
 *   - Movement / train / off-network stationary get 0 (not penalised).
 *   - Unknown placeId falls back to a small fraction (not -Infinity).
 *   - Heavy-visit places get higher log-prior than rare ones.
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
			[1, 0.5],
			[2, 0.05],
			[3, 0.01],
		]);
		const prior = buildInitialStatePrior({ placeVisitWeights: weights });
		expect(prior(state("stationary", 1))).toBeGreaterThan(prior(state("stationary", 2)));
		expect(prior(state("stationary", 2))).toBeGreaterThan(prior(state("stationary", 3)));
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
		expect(Number.isFinite(prior(state("stationary", 999)))).toBe(true);
	});

	it("typical primary-place vs rare-place delta is several nats — enough to win at t=0", () => {
		// 22-place user, primary place holds 60%, each of the other 21
		// holds ~2%. The delta should be ~4 nats — easily beats any
		// emission-side tie at GPS-null at t=0.
		const weights = new Map<number, number>();
		weights.set(1, 0.6);
		for (let i = 2; i <= 22; i++) weights.set(i, 0.02);
		const prior = buildInitialStatePrior({ placeVisitWeights: weights });
		expect(prior(state("stationary", 1)) - prior(state("stationary", 2))).toBeGreaterThan(3);
	});
});
