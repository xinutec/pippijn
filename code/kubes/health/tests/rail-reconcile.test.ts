/**
 * reconcileAdjacentRailLegs — a physical constraint: two train legs
 * that are back-to-back in the segment sequence, with nothing between
 * them, must share a station. You cannot step off one train and
 * instantly be on another at a different station. Where leg A's
 * alighting and leg B's boarding disagree, leg B is rewritten to board
 * where leg A alighted.
 */

import { describe, expect, it } from "vitest";
import { parseRailWayName, reconcileAdjacentRailLegs } from "../src/geo/passes/rail-reconcile.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

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

	it("absorbs leg B as a phantom re-arrival when both legs alight at the same station", () => {
		// Leg A alights Baker Street and leg B *also* alights Baker Street,
		// boarding elsewhere with no travel between. You already arrived at
		// Baker Street via leg A — you cannot ride to it again. Leg B is a
		// phantom (typically a coarse-fix underground reconstruction
		// duplicating leg A's tail), so it is absorbed into leg A rather than
		// left as an impossible "ride to a station you already reached".
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Baker Street", pointCount: 12 }),
			seg("train", 10, 19, { wayName: "St. John's Wood → Baker Street", pointCount: 3 }),
		];
		const out = reconcileAdjacentRailLegs(segs);
		expect(ways(out)).toEqual(["Wembley Park → Baker Street"]);
		// Leg A swallows leg B's window and fix count.
		expect(out[0].endTs).toBe(19 * 60);
		expect(out[0].pointCount).toBe(15);
	});

	it("absorbs the 2026-06-22 phantom: one Met ride emitted as two legs both alighting at Euston Square", () => {
		// The real bug. The 16-minute Wembley Park → Euston Square ride, plus a
		// 4-minute coarse-fix reconstruction that re-arrives at Euston Square
		// boarding mid-route at Baker Street. The reconstruction is absorbed;
		// one physically-coherent ride remains.
		const segs = [
			seg("train", 0, 16, { wayName: "Wembley Park → Euston Square · Metropolitan Line" }),
			seg("train", 16, 20, {
				wayName: "Baker Street → Euston Square · Circle, Hammersmith & City and Metropolitan Lines",
			}),
		];
		expect(ways(reconcileAdjacentRailLegs(segs))).toEqual(["Wembley Park → Euston Square · Metropolitan Line"]);
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
