import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/velocity.js";
import { composeWayName, mergeAdjacentMoving, mergeAdjacentStays } from "../src/geo/velocity.js";

function stay(startTs: number, endTs: number, place: string | undefined, pointCount = 5): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 0.7,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount,
		place,
	};
}

function walking(startTs: number, endTs: number, place?: string): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "walking",
		confidence: 0.5,
		avgSpeed: 4,
		maxSpeed: 6,
		linearity: 0.7,
		pointCount: 10,
		place,
	};
}

const HOUR = 3600;

describe("mergeAdjacentStays", () => {
	it("returns the same list when there is nothing to merge", () => {
		const out = mergeAdjacentStays([stay(0, HOUR, "Cafe A"), stay(2 * HOUR, 3 * HOUR, "Cafe B")]);
		expect(out).toHaveLength(2);
	});

	it("merges two directly-adjacent stays at the same place", () => {
		const out = mergeAdjacentStays([
			stay(10 * HOUR, 11 * HOUR, "Bairro Alto (cafe)", 5),
			stay(11 * HOUR, 12 * HOUR, "Bairro Alto (cafe)", 7),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].startTs).toBe(10 * HOUR);
		expect(out[0].endTs).toBe(12 * HOUR);
		expect(out[0].pointCount).toBe(12);
	});

	it("merges two stays separated by a tiny gap (≤ 5 min)", () => {
		const out = mergeAdjacentStays([
			stay(10 * HOUR, 10 * HOUR + 1800, "Home"),
			stay(10 * HOUR + 1800 + 60, 11 * HOUR, "Home"),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].endTs).toBe(11 * HOUR);
	});

	it("does NOT merge stays separated by more than 5 min", () => {
		const out = mergeAdjacentStays([stay(0, 3600, "Home"), stay(3600 + 6 * 60, 7200, "Home")]);
		expect(out).toHaveLength(2);
	});

	it("does NOT merge stays at different places", () => {
		const out = mergeAdjacentStays([stay(0, HOUR, "Cafe A"), stay(HOUR, 2 * HOUR, "Cafe B")]);
		expect(out).toHaveLength(2);
	});

	it("does NOT merge across a movement segment (walking between stays remains)", () => {
		const out = mergeAdjacentStays([
			stay(0, HOUR, "Home"),
			walking(HOUR, HOUR + 600, "Street"),
			stay(HOUR + 600, 2 * HOUR, "Home"),
		]);
		expect(out).toHaveLength(3);
		expect(out.map((s) => s.mode)).toEqual(["stationary", "walking", "stationary"]);
	});

	it("collapses a chain of three same-place stays into one", () => {
		const out = mergeAdjacentStays([
			stay(0, HOUR, "Bairro Alto"),
			stay(HOUR, 2 * HOUR, "Bairro Alto"),
			stay(2 * HOUR, 3 * HOUR, "Bairro Alto"),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].startTs).toBe(0);
		expect(out[0].endTs).toBe(3 * HOUR);
	});

	it("does NOT merge stays without a place label (place=undefined)", () => {
		// Both are unlabelled — shouldn't be coalesced just because both lack a name
		const out = mergeAdjacentStays([stay(0, HOUR, undefined), stay(HOUR, 2 * HOUR, undefined)]);
		expect(out).toHaveLength(2);
	});

	it("returns a deep copy — the original segments are not mutated", () => {
		const a = stay(0, HOUR, "Home");
		const b = stay(HOUR, 2 * HOUR, "Home");
		const out = mergeAdjacentStays([a, b]);
		expect(a.endTs).toBe(HOUR);
		expect(b.endTs).toBe(2 * HOUR);
		expect(out[0].endTs).toBe(2 * HOUR);
	});
});

function driving(
	startTs: number,
	endTs: number,
	opts: { wayName?: string; refinedMode?: string; mode?: string; avgSpeed?: number; maxSpeed?: number } = {},
): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: opts.mode ?? "driving",
		confidence: 0.7,
		avgSpeed: opts.avgSpeed ?? 90,
		maxSpeed: opts.maxSpeed ?? 100,
		linearity: 0.95,
		pointCount: Math.max(1, Math.round((endTs - startTs) / 60)),
		refinedMode: opts.refinedMode,
		wayName: opts.wayName,
	};
}

describe("mergeAdjacentMoving", () => {
	it("returns the list unchanged when there is no moving chain", () => {
		const out = mergeAdjacentMoving([stay(0, HOUR, "Home"), stay(2 * HOUR, 3 * HOUR, "Work")]);
		expect(out).toHaveLength(2);
	});

	it("merges two adjacent driving segments into one", () => {
		const out = mergeAdjacentMoving([driving(0, 600, { wayName: "A50" }), driving(600, 1500, { wayName: "A50" })]);
		expect(out).toHaveLength(1);
		expect(out[0].startTs).toBe(0);
		expect(out[0].endTs).toBe(1500);
	});

	it("merges a 'train'-classified segment refined to driving with adjacent driving", () => {
		// On the highway, the classifier flips between driving and train. Once
		// refineMode says both are driving (motorway), they should collapse.
		const out = mergeAdjacentMoving([
			driving(0, 300, { mode: "driving", refinedMode: "driving", wayName: "A50" }),
			driving(300, 600, { mode: "train", refinedMode: "driving", wayName: "A50" }),
			driving(600, 900, { mode: "driving", refinedMode: "driving", wayName: "A50" }),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].endTs).toBe(900);
	});

	it("does NOT merge across a different mode (the Tilburg walking break)", () => {
		const out = mergeAdjacentMoving([
			driving(0, 600, { wayName: "A50" }),
			{ ...driving(600, 900), mode: "walking", refinedMode: "walking" },
			driving(900, 1500, { wayName: "A58" }),
		]);
		expect(out).toHaveLength(3);
		expect(out.map((s) => s.refinedMode ?? s.mode)).toEqual(["driving", "walking", "driving"]);
	});

	it("does NOT merge if the gap exceeds the threshold", () => {
		const out = mergeAdjacentMoving([
			driving(0, 600),
			driving(600 + 5 * 60, 1200), // 5 min gap > 3 min threshold
		]);
		expect(out).toHaveLength(2);
	});

	it("leaves stationary segments alone (mergeAdjacentStays' job)", () => {
		const out = mergeAdjacentMoving([stay(0, HOUR, "Home"), stay(HOUR, 2 * HOUR, "Home")]);
		expect(out).toHaveLength(2); // no change
	});

	it("keeps maxSpeed = max of inputs and weights avgSpeed by point count", () => {
		const out = mergeAdjacentMoving([
			{ ...driving(0, 600), pointCount: 10, avgSpeed: 80, maxSpeed: 90 },
			{ ...driving(600, 1200), pointCount: 30, avgSpeed: 120, maxSpeed: 130 },
		]);
		expect(out).toHaveLength(1);
		expect(out[0].pointCount).toBe(40);
		expect(out[0].maxSpeed).toBe(130);
		// weighted avg = (10*80 + 30*120) / 40 = (800 + 3600)/40 = 110
		expect(out[0].avgSpeed).toBe(110);
	});

	it("collapses a long highway run (8 driving segments → 1) and labels by dominant ways", () => {
		// Mirrors today's Tilburg → Antwerp run: 8 short driving segments,
		// some reclassified from 'train' by refineMode, all on motorway-ish ways.
		const segs: EnrichedSegment[] = [];
		for (let i = 0; i < 8; i++) {
			const start = i * 300;
			const isTrain = i % 2 === 1;
			segs.push(
				driving(start, start + 300, {
					mode: isTrain ? "train" : "driving",
					refinedMode: "driving",
					wayName: i < 3 ? "A58" : "E19",
				}),
			);
		}
		const out = mergeAdjacentMoving(segs);
		expect(out).toHaveLength(1);
		expect(out[0].startTs).toBe(0);
		expect(out[0].endTs).toBe(8 * 300);
		// E19 = 5*300=1500s, A58 = 3*300=900s. E19 first (more time), A58 second.
		expect(out[0].wayName).toBe("E19, A58");
	});

	it("composes wayName time-weighted with two roads", () => {
		const out = mergeAdjacentMoving([
			driving(0, 600, { wayName: "A50" }), // 600s
			driving(600, 900, { wayName: "B30" }), // 300s
		]);
		expect(out).toHaveLength(1);
		expect(out[0].wayName).toBe("A50, B30");
	});

	it("drops a road that contributes under 15% of total time", () => {
		const out = mergeAdjacentMoving([
			driving(0, 900, { wayName: "E19" }), // 90% of total
			driving(900, 1000, { wayName: "Bredaseweg" }), // 10% of total — dropped
		]);
		expect(out).toHaveLength(1);
		expect(out[0].wayName).toBe("E19");
	});

	it("emits a single name when one road dominates", () => {
		const out = mergeAdjacentMoving([driving(0, 1800, { wayName: "E19" }), driving(1800, 2100, { wayName: "E19" })]);
		expect(out).toHaveLength(1);
		expect(out[0].wayName).toBe("E19");
	});

	it("drops a wayName from the budget if the joined string would exceed 30 chars", () => {
		const out = mergeAdjacentMoving([
			driving(0, 600, { wayName: "Hertogjan van Brabantlaan" }), // 25 chars
			driving(600, 1200, { wayName: "Eerste Oude Heselaan" }), // 20 chars; adding ", " + this = 47 > 30
		]);
		expect(out).toHaveLength(1);
		// Tied durations → first contributor wins, second drops out by char budget
		expect(out[0].wayName).toBe("Hertogjan van Brabantlaan");
	});

	it("does not mutate input segments", () => {
		const a = driving(0, 600, { wayName: "A50" });
		const b = driving(600, 1200, { wayName: "A50" });
		mergeAdjacentMoving([a, b]);
		expect(a.endTs).toBe(600);
		expect(b.endTs).toBe(1200);
	});
});

describe("composeWayName", () => {
	it("returns null for an empty contribution map", () => {
		expect(composeWayName(new Map())).toBeNull();
	});

	it("returns the only contributor's name when there is one", () => {
		expect(composeWayName(new Map([["A1", 600]]))).toBe("A1");
	});

	it("orders by descending time", () => {
		const m = new Map([
			["B", 200],
			["A", 800],
		]);
		expect(composeWayName(m)).toBe("A, B");
	});

	it("caps at three names", () => {
		const m = new Map([
			["A", 400],
			["B", 300],
			["C", 200],
			["D", 100],
		]);
		// Total 1000; D = 10% < 15% floor → drop. A,B,C all > 15% → "A, B, C".
		expect(composeWayName(m)).toBe("A, B, C");
	});
});
