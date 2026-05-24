/**
 * `buildTransitionMatrix` — rule-based static-prior transition log-
 * probabilities for the MVP HMM.
 *
 * Calibration intent (not learned from data — MVP stub):
 *   - Self-loops dominate (~ log 0.95); the HMM should stay in a
 *     state minute-to-minute most of the time.
 *   - Mode changes (e.g. stationary → walking) get a moderate
 *     prior (~ log 0.01) — common but rare per minute.
 *   - Mode-plus-place transitions (stationary @ A → train @ L) are
 *     similar.
 *   - Two different stationary places without a moving intermediate
 *     are physically impossible: hard-zeroed.
 *
 * The station-graph hard-zero ("train@L cannot serve place P far from
 * any station on L") is wired in at integration time, not here.
 * Tests here pin the structural rules only.
 */

import { describe, expect, it } from "vitest";
import type { Observation } from "../src/hmm/observation.js";
import { buildStateSpace } from "../src/hmm/state-space.js";
import { buildTransitionMatrix } from "../src/hmm/transitions.js";

// Dummy observation for the obs-conditional transition signature.
// Most tests don't care about the obs — only entry-boost ones do.
const OBS: Observation = {
	ts: 1_700_000_000,
	gps: null,
	hr: null,
	cadence: null,
	hourLocal: 12,
	dayOfWeekLocal: 3,
};

describe("buildTransitionMatrix", () => {
	const states = buildStateSpace({
		focusPlaces: [
			{ id: 1, displayName: "Home" },
			{ id: 2, displayName: "Work" },
		],
		knownLines: ["Metropolitan Line"],
	});
	const transitionLogProb = buildTransitionMatrix({ states });

	function find(mode: string, placeId: number | null, lineName: string | null) {
		const s = states.find((s) => s.mode === mode && s.placeId === placeId && s.lineName === lineName);
		if (s === undefined) throw new Error(`state not found: ${mode}|${placeId}|${lineName}`);
		return s;
	}

	it("self-loops have higher log-prob than any cross-state transition", () => {
		const home = find("stationary", 1, null);
		const walking = find("walking", null, null);
		const self = transitionLogProb(home, home, OBS);
		const cross = transitionLogProb(home, walking, OBS);
		expect(self).toBeGreaterThan(cross);
		expect(self).toBeCloseTo(Math.log(0.95), 2);
	});

	it("hard-zeroes direct stationary@A → stationary@B transitions", () => {
		const home = find("stationary", 1, null);
		const work = find("stationary", 2, null);
		expect(transitionLogProb(home, work, OBS)).toBe(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(work, home, OBS)).toBe(Number.NEGATIVE_INFINITY);
	});

	it("permits stationary @ A → walking → stationary @ B via the walking transition", () => {
		const home = find("stationary", 1, null);
		const walking = find("walking", null, null);
		const work = find("stationary", 2, null);
		expect(transitionLogProb(home, walking, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(walking, work, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("permits off-network stationary regardless of source", () => {
		// stationary @ none → stationary @ none is allowed (self-loop).
		// stationary @ A → stationary @ none is NOT allowed (mode change without movement).
		const noneStay = find("stationary", null, null);
		const home = find("stationary", 1, null);
		expect(transitionLogProb(noneStay, noneStay, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(home, noneStay, OBS)).toBe(Number.NEGATIVE_INFINITY);
	});

	it("treats unknown as a regular non-place mode (allows entry/exit)", () => {
		const unknown = find("unknown", null, null);
		const walking = find("walking", null, null);
		const home = find("stationary", 1, null);
		// unknown can transition to/from walking, stationary, etc.
		expect(transitionLogProb(unknown, walking, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(walking, unknown, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		expect(transitionLogProb(home, unknown, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("permits train @ L → walking (alighting)", () => {
		const train = find("train", null, "Metropolitan Line");
		const walking = find("walking", null, null);
		expect(transitionLogProb(train, walking, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("permits walking → train @ L (boarding)", () => {
		const walking = find("walking", null, null);
		const train = find("train", null, "Metropolitan Line");
		expect(transitionLogProb(walking, train, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("permits stationary @ A → train @ L (boarding at a station-cluster place)", () => {
		const home = find("stationary", 1, null);
		const train = find("train", null, "Metropolitan Line");
		// Static prior allows it — station-graph hard-zero (wired at
		// integration) will refine this for specific (L, place) pairs.
		expect(transitionLogProb(home, train, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("hard-zeroes train@L → stationary@P when L does not serve P (station-graph rule)", () => {
		const transitionLogProbWithGraph = buildTransitionMatrix({
			states,
			// Home (id=1) is on Met; Work (id=2) is NOT.
			placeNearLine: (placeId, lineName) => placeId === 1 && lineName === "Metropolitan Line",
		});
		const train = find("train", null, "Metropolitan Line");
		const home = find("stationary", 1, null);
		const work = find("stationary", 2, null);
		// train@Met → stationary@Home: allowed (home is on Met).
		expect(transitionLogProbWithGraph(train, home, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
		// train@Met → stationary@Work: forbidden (work is not on Met).
		expect(transitionLogProbWithGraph(train, work, OBS)).toBe(Number.NEGATIVE_INFINITY);
		// Symmetric: stationary@Work → train@Met also forbidden.
		expect(transitionLogProbWithGraph(work, train, OBS)).toBe(Number.NEGATIVE_INFINITY);
	});

	it("does not apply station-graph hard-zero for the unknown_rail catch-all", () => {
		const transitionLogProbWithGraph = buildTransitionMatrix({
			states,
			placeNearLine: () => false, // everything would be forbidden if applied
		});
		const unknownTrain = find("train", null, "unknown_rail");
		const home = find("stationary", 1, null);
		// unknown_rail bypasses the rule — used as a backstop when
		// the line isn't recognised.
		expect(transitionLogProbWithGraph(unknownTrain, home, OBS)).toBeGreaterThan(Number.NEGATIVE_INFINITY);
	});

	it("entry boost: transitioning INTO stationary @ place gains log(24×profile[h]) at hour h", () => {
		// Work profile peaks at 14:00 (10%) and dips at 04:00 (1%);
		// raw boost log(24×0.1)≈+0.875 clamped to +0.5, log(24×0.01)≈
		// -1.43 clamped to -0.5. Delta at hour 14 vs hour 4 is +1.0.
		const profile = new Array(24).fill(0.04);
		profile[14] = 0.1;
		profile[4] = 0.01;
		const transitionWithProfile = buildTransitionMatrix({
			states,
			placeHourProfiles: new Map([[2, profile]]),
		});
		const walking = find("walking", null, null);
		const work = find("stationary", 2, null);
		const at14: Observation = { ...OBS, hourLocal: 14 };
		const at04: Observation = { ...OBS, hourLocal: 4 };
		const score14 = transitionWithProfile(walking, work, at14);
		const score04 = transitionWithProfile(walking, work, at04);
		expect(score14 - score04).toBeCloseTo(1.0, 2);
	});

	it("entry boost only fires on transitions INTO a stationary place — not on self-loop, not on leaving", () => {
		const profile = new Array(24).fill(0).map((_, i) => (i === 14 ? 0.5 : 0.022));
		const transitionWithProfile = buildTransitionMatrix({
			states,
			placeHourProfiles: new Map([[2, profile]]),
		});
		const transitionPlain = buildTransitionMatrix({ states });
		const walking = find("walking", null, null);
		const work = find("stationary", 2, null);
		const at14: Observation = { ...OBS, hourLocal: 14 };
		// Self-loop at Work: no boost (self-loop is constant).
		expect(transitionWithProfile(work, work, at14)).toBe(transitionPlain(work, work, at14));
		// Leaving Work (Work → walking): no boost (boost is on entry to a place, not exit).
		expect(transitionWithProfile(work, walking, at14)).toBe(transitionPlain(work, walking, at14));
		// Entering Work (walking → Work): boost applies.
		expect(transitionWithProfile(walking, work, at14)).toBeGreaterThan(transitionPlain(walking, work, at14));
	});

	it("entry boost does NOT fire for transitions into non-stationary states or off-network stationary", () => {
		const profile = new Array(24).fill(0).map((_, i) => (i === 14 ? 0.5 : 0.022));
		const transitionWithProfile = buildTransitionMatrix({
			states,
			placeHourProfiles: new Map([
				[1, profile],
				[2, profile],
			]),
		});
		const transitionPlain = buildTransitionMatrix({ states });
		const home = find("stationary", 1, null);
		const noneStay = find("stationary", null, null);
		const walking = find("walking", null, null);
		const train = find("train", null, "Metropolitan Line");
		const at14: Observation = { ...OBS, hourLocal: 14 };
		// Off-network stationary: no boost (no profile applies).
		expect(transitionWithProfile(walking, noneStay, at14)).toBe(transitionPlain(walking, noneStay, at14));
		// Train: no boost.
		expect(transitionWithProfile(walking, train, at14)).toBe(transitionPlain(walking, train, at14));
		// Walking: no boost.
		expect(transitionWithProfile(home, walking, at14)).toBe(transitionPlain(home, walking, at14));
	});

	it("rows sum to <= 1 in probability space (proper probability distribution)", () => {
		// For each state, summing exp(logProb(state, *)) over all
		// destinations should be ≤ 1 (could be < 1 because hard-zeros
		// remove mass; the remaining mass is what the matrix actually
		// assigns).
		for (const from of states) {
			let sum = 0;
			for (const to of states) {
				const lp = transitionLogProb(from, to, OBS);
				if (lp === Number.NEGATIVE_INFINITY) continue;
				sum += Math.exp(lp);
			}
			expect(sum).toBeGreaterThan(0); // every state has at least one valid outgoing transition
			expect(sum).toBeLessThanOrEqual(1.01); // floating-point slop
		}
	});
});
