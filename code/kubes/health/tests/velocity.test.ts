import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TransportMode } from "../src/geo/segments.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";
import { annotateRailRuns, composeWayName, mergeAdjacentMoving, mergeAdjacentStays } from "../src/geo/velocity.js";

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
	opts: {
		wayName?: string;
		refinedMode?: TransportMode;
		mode?: TransportMode;
		avgSpeed?: number;
		maxSpeed?: number;
	} = {},
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

	it("does NOT merge two moving segments in different cities", () => {
		const a: EnrichedSegment = { ...driving(0, 600, { wayName: "Hoge" }), city: "Tilburg" };
		const b: EnrichedSegment = { ...driving(600, 1200, { wayName: "Bd" }), city: "Brussels" };
		const out = mergeAdjacentMoving([a, b]);
		expect(out).toHaveLength(2);
		expect(out[0].city).toBe("Tilburg");
		expect(out[1].city).toBe("Brussels");
	});

	it("merges a city-tagged segment into an untagged transit, dropping the city", () => {
		// Loose merge: only strictly-conflicting cities (both defined and
		// different) block the merge. A defined city next to untagged transit
		// merges, but the merged segment loses the city tag — the merged span
		// no longer corresponds to a single city, so claiming it does would
		// be misleading.
		const a: EnrichedSegment = { ...driving(0, 600, { wayName: "Bd" }), city: "Tilburg" };
		const b = driving(600, 1200, { wayName: "A58" }); // no city — transit
		const out = mergeAdjacentMoving([a, b]);
		expect(out).toHaveLength(1);
		expect(out[0].city).toBeUndefined();
	});

	it("DOES merge two moving segments in the same city", () => {
		const a: EnrichedSegment = { ...driving(0, 600, { wayName: "S1" }), city: "Tilburg" };
		const b: EnrichedSegment = { ...driving(600, 1200, { wayName: "S2" }), city: "Tilburg" };
		const out = mergeAdjacentMoving([a, b]);
		expect(out).toHaveLength(1);
		expect(out[0].city).toBe("Tilburg");
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

describe("annotateRailRuns", () => {
	const train = (startTs: number, endTs: number, refinedReason?: string): EnrichedSegment => ({
		startTs,
		endTs,
		mode: "train",
		refinedMode: "train",
		confidence: 0.6,
		avgSpeed: 80,
		maxSpeed: 100,
		linearity: 0.98,
		pointCount: 30,
		refinedReason,
	});

	const inferredVehicleGap = (startTs: number, endTs: number): EnrichedSegment => ({
		startTs,
		endTs,
		mode: "driving",
		confidence: 0.3,
		avgSpeed: 42,
		maxSpeed: 42,
		linearity: 1,
		pointCount: 0,
		refinedReason: "inferred from GPS gap (3.2 km in 5 min)",
	});

	const fix = (ts: number, lat: number, lon: number): FilteredPoint => ({
		ts,
		lat,
		lon,
		speed_kmh: 0,
		bearing: 0,
	});

	// Kings Cross 51.530,-0.125 ; Baker Street 51.523,-0.158 ; Wembley Park 51.563,-0.279
	const stationAt = (lat: number, lon: number): string => {
		if (Math.abs(lat - 51.53) < 0.01 && Math.abs(lon - -0.125) < 0.01) return "Kings Cross St Pancras";
		if (Math.abs(lat - 51.523) < 0.01 && Math.abs(lon - -0.158) < 0.01) return "Baker Street";
		if (Math.abs(lat - 51.563) < 0.01 && Math.abs(lon - -0.279) < 0.01) return "Wembley Park";
		return "Unknown";
	};
	const lookup = async (lat: number, lon: number) => [{ name: stationAt(lat, lon) }];

	it("annotates a single train segment with its outer-bounding-fix stations", async () => {
		const segs = [train(1000, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("merges train + inferred-gap + train into one journey with one label", async () => {
		// The Baker Street bug: a single mid-ride noisy fix splits the tube
		// ride into two train segments separated by an inferred vehicle gap.
		// Each segment used to get its own start/end station, producing
		// Wembley → Baker Street and Baker Street → Kings Cross.
		// After merge-then-annotate: one outer-bounded label applies to all.
		const segs = [train(1000, 1200), inferredVehicleGap(1200, 1300), train(1300, 1500)];
		const points = [
			fix(900, 51.53, -0.125), // Kings Cross — before run
			fix(1250, 51.523, -0.158), // Baker Street — mid-ride noise
			fix(1600, 51.563, -0.279), // Wembley Park — after run
		];
		const out = await annotateRailRuns(segs, points, lookup);
		// All three segments share the run's outer-bounded label.
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
		expect(out[1].wayName).toBe("Kings Cross St Pancras → Wembley Park");
		expect(out[2].wayName).toBe("Kings Cross St Pancras → Wembley Park");
		// And the gap segment is upgraded to train.
		expect(out[1].mode).toBe("train");
		expect(out[1].refinedMode).toBe("train");
	});

	it("does not merge two train runs separated by a non-rail segment", async () => {
		const stationary: EnrichedSegment = {
			startTs: 1200,
			endTs: 1800,
			mode: "stationary",
			confidence: 0.7,
			avgSpeed: 0,
			maxSpeed: 0,
			linearity: 0,
			pointCount: 5,
		};
		const segs = [train(1000, 1200), stationary, train(1800, 2000)];
		const points = [
			fix(900, 51.53, -0.125), // Kings Cross
			fix(1100, 51.53, -0.125),
			fix(1900, 51.563, -0.279), // Wembley
			fix(2100, 51.563, -0.279),
		];
		const out = await annotateRailRuns(segs, points, lookup);
		// Each train segment is its own 1-segment run.
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
		// The stationary segment is untouched (no rail-like classification).
		expect(out[1].wayName).toBeUndefined();
		expect(out[2].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("skips annotation when both endpoints resolve to the same station", async () => {
		// Hanging out near the station, not actually riding.
		const segs = [train(1000, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.53, -0.125)];
		const out = await annotateRailRuns(segs, points, lookup);
		expect(out[0].wayName).toBeUndefined();
	});

	it("leaves non-rail segments alone", async () => {
		const driving: EnrichedSegment = {
			startTs: 1000,
			endTs: 1500,
			mode: "driving",
			confidence: 0.7,
			avgSpeed: 60,
			maxSpeed: 80,
			linearity: 0.6,
			pointCount: 20,
			wayName: "M25",
		};
		const out = await annotateRailRuns([driving], [fix(900, 51.5, -0.1)], lookup);
		expect(out[0].wayName).toBe("M25"); // unchanged
	});

	it("preserves refinedReason and chains the upgrade reason on the gap segment", async () => {
		const segs = [train(1000, 1200), inferredVehicleGap(1200, 1300), train(1300, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup);
		expect(out[1].refinedReason).toContain("inferred from GPS gap");
		expect(out[1].refinedReason).toContain("tube ride between known stations");
	});

	// Line-intersection disambiguation. The user's commute Wembley Park →
	// Kings Cross has the parallel-track Met/Jubilee ambiguity (both serve
	// Wembley Park; Jubilee doesn't reach Kings Cross). When both lookups
	// agree on exactly one line, append the line name to the label.
	it("appends line name when both endpoints' line sets intersect to one line", async () => {
		// Wembley Park is served by Met + Jubilee; Kings Cross by Met +
		// many others but NOT Jubilee. Intersection = {Met} → use it.
		const linesAt = async (lat: number, _lon: number): Promise<Set<string>> => {
			if (Math.abs(lat - 51.563) < 0.01) return new Set(["Metropolitan Line", "Jubilee Line"]);
			if (Math.abs(lat - 51.53) < 0.01)
				return new Set(["Metropolitan Line", "Circle Line", "Northern Line", "Piccadilly Line", "Victoria Line"]);
			return new Set();
		};
		const segs = [train(1000, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup, linesAt);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park · Metropolitan Line");
	});

	it("omits line name when intersection has more than one line (ambiguous)", async () => {
		// Two lines both serve both endpoints — can't disambiguate.
		const linesAt = async () => new Set(["Northern Line", "Victoria Line"]);
		const segs = [train(1000, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup, linesAt);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("omits line name when intersection is empty (one endpoint has no lines)", async () => {
		// Train ride ending at a non-station: OSM has no route serving that
		// coord. Annotation falls back to the bare station pair.
		const linesAt = async (lat: number, _lon: number): Promise<Set<string>> => {
			if (Math.abs(lat - 51.53) < 0.01) return new Set(["Metropolitan Line"]);
			return new Set();
		};
		const segs = [train(1000, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup, linesAt);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("omits line name when intersection is empty (lines disjoint)", async () => {
		// Surfaced bug case: refineMode might think the tracks belong to
		// Line A near one fix and Line B near the other, but no line
		// actually serves both physical points. Skip line tagging.
		const linesAt = async (lat: number, _lon: number): Promise<Set<string>> => {
			if (Math.abs(lat - 51.53) < 0.01) return new Set(["Northern Line"]);
			if (Math.abs(lat - 51.563) < 0.01) return new Set(["Jubilee Line"]);
			return new Set();
		};
		const segs = [train(1000, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup, linesAt);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("does not call line-lookup when station annotation was already skipped", async () => {
		// Same station both ends → skip. The line lookup should not fire
		// (avoids unnecessary network calls for a non-annotation case).
		let linesAtCalls = 0;
		const linesAt = async () => {
			linesAtCalls++;
			return new Set<string>();
		};
		const segs = [train(1000, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.53, -0.125)];
		await annotateRailRuns(segs, points, lookup, linesAt);
		expect(linesAtCalls).toBe(0);
	});
});
