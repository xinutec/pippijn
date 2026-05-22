/**
 * reconcileAdjacentRailLegs — a physical constraint: two train legs
 * that are back-to-back in the segment sequence, with nothing between
 * them, must share a station. You cannot step off one train and
 * instantly be on another at a different station. Where leg A's
 * alighting and leg B's boarding disagree, leg B is rewritten to board
 * where leg A alighted.
 */

import { describe, expect, it } from "vitest";
import { type EnrichedSegment, parseRailWayName, reconcileAdjacentRailLegs } from "../src/geo/velocity.js";

/** Build an EnrichedSegment; times given in whole minutes for clarity. */
function seg(
	mode: EnrichedSegment["mode"],
	startMin: number,
	endMin: number,
	extra: Partial<EnrichedSegment> = {},
): EnrichedSegment {
	return {
		startTs: startMin * 60,
		endTs: endMin * 60,
		mode,
		refinedMode: mode,
		confidence: 0.9,
		confidenceMargin: 5,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 10,
		...extra,
	};
}

const ways = (segs: EnrichedSegment[]): (string | undefined)[] => segs.map((s) => s.wayName);

describe("parseRailWayName", () => {
	it("parses a bare station pair", () => {
		expect(parseRailWayName("Wembley Park → Baker Street")).toEqual({
			board: "Wembley Park",
			alight: "Baker Street",
		});
	});

	it("parses a station pair with a line suffix", () => {
		expect(parseRailWayName("St. John's Wood → Green Park · Jubilee Line")).toEqual({
			board: "St. John's Wood",
			alight: "Green Park",
			line: "Jubilee Line",
		});
	});

	it("returns null for a non-rail wayName", () => {
		expect(parseRailWayName("A406 North Circular Road")).toBeNull();
		expect(parseRailWayName(undefined)).toBeNull();
	});
});

describe("reconcileAdjacentRailLegs", () => {
	it("rewrites leg B to board where leg A alighted when they disagree", () => {
		// The real 2026-05-22 bug: leg A alights Baker Street, leg B's
		// boarding was independently resolved to St. John's Wood — one
		// stop *behind* Baker Street, an impossible backward jump.
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Baker Street" }),
			seg("train", 10, 19, { wayName: "St. John's Wood → Green Park · Jubilee Line" }),
		];
		const out = reconcileAdjacentRailLegs(segs);
		expect(ways(out)).toEqual(["Wembley Park → Baker Street", "Baker Street → Green Park · Jubilee Line"]);
	});

	it("leaves legs that already share a station untouched", () => {
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Baker Street" }),
			seg("train", 10, 19, { wayName: "Baker Street → Green Park · Jubilee Line" }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual([
			"Wembley Park → Baker Street",
			"Baker Street → Green Park · Jubilee Line",
		]);
	});

	it("does not touch legs separated by another segment — not back-to-back", () => {
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Baker Street" }),
			seg("walking", 10, 25),
			seg("train", 25, 35, { wayName: "St. John's Wood → Green Park · Jubilee Line" }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual([
			"Wembley Park → Baker Street",
			undefined,
			"St. John's Wood → Green Park · Jubilee Line",
		]);
	});

	it("propagates the correction along a chain of three legs", () => {
		const segs = [
			seg("train", 0, 10, { wayName: "A → B" }),
			seg("train", 10, 20, { wayName: "X → C" }),
			seg("train", 20, 30, { wayName: "Y → D" }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual(["A → B", "B → C", "C → D"]);
	});

	it("skips a leg with a non-rail wayName", () => {
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Baker Street" }),
			seg("train", 10, 19, { wayName: undefined }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual(["Wembley Park → Baker Street", undefined]);
	});

	it("respects refinedMode — an underground run upgraded to train still reconciles", () => {
		const segs = [
			seg("driving", 0, 10, { refinedMode: "train", wayName: "Wembley Park → Baker Street" }),
			seg("walking", 10, 19, { refinedMode: "train", wayName: "St. John's Wood → Green Park" }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual(["Wembley Park → Baker Street", "Baker Street → Green Park"]);
	});

	it("skips when the rewrite would make a same-station run", () => {
		// Leg A alights Baker Street and leg B also alights Baker Street —
		// rewriting B's boarding to Baker Street yields a degenerate
		// Baker Street → Baker Street. Leave B alone.
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Baker Street" }),
			seg("train", 10, 19, { wayName: "St. John's Wood → Baker Street" }),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual([
			"Wembley Park → Baker Street",
			"St. John's Wood → Baker Street",
		]);
	});

	it("does not mutate the input segments", () => {
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Baker Street" }),
			seg("train", 10, 19, { wayName: "St. John's Wood → Green Park" }),
		];
		reconcileAdjacentRailLegs(segs);
		expect(segs[1].wayName).toBe("St. John's Wood → Green Park");
	});
});
