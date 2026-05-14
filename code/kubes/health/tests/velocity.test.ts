import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TransportMode } from "../src/geo/segments.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";
import {
	annotateRailRuns,
	composeWayName,
	mergeAdjacentMoving,
	mergeAdjacentStays,
	shouldUseClusterAmenity,
} from "../src/geo/velocity.js";

function stay(startTs: number, endTs: number, place: string | undefined, pointCount = 5): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 0.7,
		confidenceMargin: 10,
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
		confidenceMargin: 2,
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
		confidenceMargin: 5,
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
		confidenceMargin: 3,
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
		confidenceMargin: 1.2,
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
	const lookup = async (lat: number, lon: number) => [{ name: stationAt(lat, lon), subtype: "subway", distanceM: 50 }];

	it("annotates a single train segment with its outer-bounding-fix stations", async () => {
		const segs = [train(1000, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("collapses train + inferred-gap + train into one journey", async () => {
		// The Baker Street bug: a single mid-ride noisy fix splits the tube
		// ride into two train segments separated by an inferred vehicle
		// gap. After the merge: one continuous train segment from the
		// run's true start to its true end, labeled by outer-bounding
		// stations. The intermediate inferred-gap artefact disappears.
		const segs = [train(1000, 1200), inferredVehicleGap(1200, 1300), train(1300, 1500)];
		const points = [
			fix(900, 51.53, -0.125), // Kings Cross — before run
			fix(1250, 51.523, -0.158), // Baker Street — mid-ride noise
			fix(1600, 51.563, -0.279), // Wembley Park — after run
		];
		const out = await annotateRailRuns(segs, points, lookup);
		// Three input segments collapse to one continuous train segment.
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("train");
		expect(out[0].startTs).toBe(1000);
		expect(out[0].endTs).toBe(1500);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("does not merge two train runs separated by a non-rail segment", async () => {
		const stationary: EnrichedSegment = {
			startTs: 1200,
			endTs: 1800,
			mode: "stationary",
			confidence: 0.7,
			confidenceMargin: 10,
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
			confidenceMargin: 5,
			avgSpeed: 60,
			maxSpeed: 80,
			linearity: 0.6,
			pointCount: 20,
			wayName: "M25",
		};
		const out = await annotateRailRuns([driving], [fix(900, 51.5, -0.1)], lookup);
		expect(out[0].wayName).toBe("M25"); // unchanged
	});

	it("upgrades a single inferred-gap driving segment to train when both endpoints resolve to stations", async () => {
		// Bug pattern: a tube ride shows up in the timeline as a single
		// "driving" segment annotated with a station pair. The
		// annotation is correct but the mode is wrong — internally
		// contradictory, and downstream code (UI icons, stats) treats
		// it as a car drive. annotateRailRuns already produces the
		// wayName label; it should also flip the mode to "train" when
		// the label is produced (because we have high-confidence rail
		// evidence: BOTH endpoints are real stations and the segment
		// is rail-like by GPS shape).
		const segs = [inferredVehicleGap(1000, 1500)];
		const points = [fix(900, 51.523, -0.158), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup);
		expect(out[0].wayName).toBe("Baker Street → Wembley Park");
		expect(out[0].mode).toBe("train");
		expect(out[0].refinedMode).toBe("train");
	});

	it("upgrades a single high-linearity driving segment without label only if station lookup produces a pair", async () => {
		// Negative control: when annotateRailRuns *fails* to find a
		// station pair (e.g. user wasn't actually near a station), the
		// mode stays as the input — we should not upgrade on weak
		// evidence. The high linearity alone isn't enough.
		const seg = inferredVehicleGap(1000, 1500);
		const points = [fix(900, 51.5, -0.1), fix(1600, 51.6, -0.2)];
		const noStations = async () => [];
		const out = await annotateRailRuns([seg], points, noStations);
		expect(out[0].mode).toBe("driving"); // unchanged
		expect(out[0].wayName).toBeUndefined();
	});

	it("tags the collapsed run with a refinedReason describing the merge", async () => {
		// Multi-segment runs collapse, so the per-segment refinedReason of
		// individual inferred-gap segments is gone. The merged segment
		// carries its own reason explaining the collapse.
		const segs = [train(1000, 1200), inferredVehicleGap(1200, 1300), train(1300, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup);
		expect(out).toHaveLength(1);
		expect(out[0].refinedReason).toMatch(/merged rail run/);
	});

	// Line-intersection disambiguation. The Wembley Park ↔ Kings Cross
	// corridor has a parallel-track Met/Jubilee ambiguity (both serve
	// Wembley Park; Jubilee doesn't reach Kings Cross). When both
	// lookups agree on exactly one line, append the line name to the
	// label.
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

	// Platform-transfer absorption. A real journey is "Kings Cross →
	// (board) → tube → (transfer at Baker Street) → tube → (alight) →
	// Wembley Park". The classifier produces train + stationary + train.
	// Without absorption the rail run is broken into two halves, each
	// gets its own (wrong) station-pair label, and the interior
	// stationary segment gets labelled as the nearest cafe.

	const platformStationary = (startTs: number, endTs: number, place: string): EnrichedSegment => ({
		startTs,
		endTs,
		mode: "stationary",
		confidence: 0.7,
		confidenceMargin: 5,
		avgSpeed: 0.5,
		maxSpeed: 2,
		linearity: 0.3,
		pointCount: 3,
		place,
	});

	it("ignores the boundary fix at seg.endTs when picking the preceding stationary's location", async () => {
		// A stationary segment immediately preceded by a train segment
		// has endTs == next train's startTs. The fix at that shared
		// boundary timestamp is the FIRST fix of the next segment —
		// already mid-ride at train speed and at the wrong location.
		// The old filter `p.ts >= seg.startTs && p.ts <= seg.endTs`
		// picked that fix as the stationary's "last fix", so:
		//
		//   - stationaryCandidate.lat/lon = mid-ride boundary fix
		//   - stationsLookup → wrong-station-near-train-path
		//   - apparentKmh from that candidate to slowBefore (at the
		//     real station): hundreds of metres / clamped-1s dt
		//     → many hundreds of km/h » 15 km/h threshold
		//   - algorithm decides "slowBefore is mid-tunnel noise,
		//     trust stationaryCandidate" → wrong boarding station
		//
		// Fix: strict `<` on the upper bound, because endTs is the
		// next segment's startTs, not this segment's last fix.
		const stationary: EnrichedSegment = {
			startTs: 1000,
			endTs: 1200,
			mode: "stationary",
			confidence: 0.7,
			confidenceMargin: 5,
			avgSpeed: 0.5,
			maxSpeed: 2,
			linearity: 0.3,
			pointCount: 5,
		};
		const segs = [stationary, train(1200, 1500)];
		const points = [
			fix(1050, 51.53, -0.125), // truly stationary inside Kings Cross
			fix(1100, 51.53, -0.125), // ditto
			fix(1200, 51.523, -0.158), // BOUNDARY: shared with train.startTs;
			//                            classifier put this into stationary
			//                            but it's mid-ride at Baker Street.
			fix(1600, 51.563, -0.279), // Wembley Park — after train
		];
		const out = await annotateRailRuns(segs, points, lookup);
		// The train (segment index 1) should be labelled Kings Cross →
		// Wembley Park. With the bug, it would be Baker Street → Wembley
		// Park because the boundary fix at ts=1200 was treated as the
		// stationary's last fix.
		expect(out[1].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("collapses train + short-stationary + train into one continuous train segment", async () => {
		// A brief train pause (signal stop, station dwell — not a transfer)
		// shouldn't appear in the timeline. The 2-minute stationary fix is
		// just GPS recording the train stopped briefly; the user was on the
		// same train the whole time. Collapse to a single segment.
		const stations = async (
			lat: number,
			_lon: number,
		): Promise<{ name: string; subtype: string; distanceM: number }[]> => {
			if (Math.abs(lat - 51.53) < 0.01) return [{ name: "Kings Cross St Pancras", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.563) < 0.01) return [{ name: "Wembley Park", subtype: "subway", distanceM: 50 }];
			return [];
		};
		const segs = [
			train(1000, 1180), // first half
			platformStationary(1180, 1300, "Saint Espresso (cafe)"), // 2-min train pause
			train(1300, 1500), // second half
		];
		const points = [
			fix(900, 51.53, -0.125), // Kings Cross
			fix(1600, 51.563, -0.279), // Wembley Park
		];
		const out = await annotateRailRuns(segs, points, stations);
		// 3 input segments collapse into 1 train segment spanning the whole ride.
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("train");
		expect(out[0].startTs).toBe(1000);
		expect(out[0].endTs).toBe(1500);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("collapses a multi-segment rail run even without absorbed stationary", async () => {
		// Three consecutive train/inferred-gap segments → one continuous
		// train ride. The user's mental model: I got on at A, off at B.
		// No need to surface the per-window classifier output as separate
		// timeline entries.
		const stations = async (
			lat: number,
			_lon: number,
		): Promise<{ name: string; subtype: string; distanceM: number }[]> => {
			if (Math.abs(lat - 51.53) < 0.01) return [{ name: "Kings Cross St Pancras", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.563) < 0.01) return [{ name: "Wembley Park", subtype: "subway", distanceM: 50 }];
			return [];
		};
		const segs = [train(1000, 1200), train(1200, 1300), train(1300, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, stations);
		expect(out).toHaveLength(1);
		expect(out[0].startTs).toBe(1000);
		expect(out[0].endTs).toBe(1500);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("leaves a single-segment rail run as-is (just annotates)", async () => {
		// Don't collapse for collapse's sake. A single train segment is
		// already shaped right.
		const stations = async (
			lat: number,
			_lon: number,
		): Promise<{ name: string; subtype: string; distanceM: number }[]> => {
			if (Math.abs(lat - 51.53) < 0.01) return [{ name: "Kings Cross St Pancras", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.563) < 0.01) return [{ name: "Wembley Park", subtype: "subway", distanceM: 50 }];
			return [];
		};
		const segs = [train(1000, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, stations);
		expect(out).toHaveLength(1);
		expect(out[0].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("does NOT absorb a long-stationary (> 5 min) between two rail segments", async () => {
		// 30 minutes between trains is a real visit, not a brief pause.
		const segs = [
			train(1000, 1180),
			platformStationary(1180, 1180 + 30 * 60, "Saint Espresso (cafe)"),
			train(1180 + 30 * 60, 1180 + 30 * 60 + 200),
		];
		const points = [fix(900, 51.53, -0.125), fix(1180 + 30 * 60 + 300, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, lookup);
		// All three segments survive; the cafe label is preserved.
		expect(out).toHaveLength(3);
		expect(out[1].place).toBe("Saint Espresso (cafe)");
	});

	it("does NOT absorb a short stationary that is NOT between two rail segments", async () => {
		const walking: EnrichedSegment = {
			startTs: 800,
			endTs: 1180,
			mode: "walking",
			confidence: 0.8,
			confidenceMargin: 4,
			avgSpeed: 5,
			maxSpeed: 6,
			linearity: 0.7,
			pointCount: 20,
		};
		const walkingAfter: EnrichedSegment = { ...walking, startTs: 1300, endTs: 1500 };
		const segs = [walking, platformStationary(1180, 1300, "Saint Espresso (cafe)"), walkingAfter];
		const points = [fix(700, 51.523, -0.158), fix(1600, 51.523, -0.158)];
		const out = await annotateRailRuns(segs, points, lookup);
		expect(out).toHaveLength(3);
		expect(out[1].place).toBe("Saint Espresso (cafe)");
	});

	it("preserves rail-run collapse when station lookup fails (graceful degradation)", async () => {
		// Without station data, the run still collapses — we lose the
		// station-pair label but keep the correct shape (one train
		// segment, not three artefacts). The Overpass-outage case.
		const noStations = async () => [];
		const segs = [train(1000, 1180), platformStationary(1180, 1300, "Saint Espresso (cafe)"), train(1300, 1500)];
		const points = [fix(900, 51.53, -0.125), fix(1600, 51.563, -0.279)];
		const out = await annotateRailRuns(segs, points, noStations);
		// Still one segment; just without the station-pair label.
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("train");
		expect(out[0].startTs).toBe(1000);
		expect(out[0].endTs).toBe(1500);
	});

	// --- Boarding-station inference from preceding stationary segment ---
	// Pattern: a Stationary segment next to a tube station, a brief
	// walking segment through the station entrance, then a tube ride.
	// The "last slow fix before the run" lookup can pick up a noisy
	// underground blip from a different (intermediate) station, mis-
	// attributing the boarding. The preceding stationary segment's
	// location is a stronger signal of where the trip actually started.

	const stationaryAt = (startTs: number, endTs: number): EnrichedSegment => ({
		startTs,
		endTs,
		mode: "stationary",
		confidence: 1,
		confidenceMargin: Infinity,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 5,
	});

	const walking = (startTs: number, endTs: number): EnrichedSegment => ({
		startTs,
		endTs,
		mode: "walking",
		confidence: 0.8,
		confidenceMargin: 4,
		avgSpeed: 4,
		maxSpeed: 6,
		linearity: 0.5,
		pointCount: 5,
	});

	it("uses the preceding stationary segment's location for the boarding station", async () => {
		// stationary → walking (TO the station) → train run. The slow
		// fix immediately before the train segment is a noisy lock near
		// Baker Street (mid-tunnel signal recovery) — the kind of fix
		// the old "latest slow fix" lookup picks. The stationary
		// segment's location at Kings Cross should win.
		const segs = [stationaryAt(800, 1000), walking(1000, 1500), train(1500, 2000)];
		const points = [
			fix(900, 51.53, -0.125), // inside stationary, Kings Cross
			fix(990, 51.53, -0.125), // last fix before walking starts, Kings Cross
			fix(1400, 51.523, -0.158), // noisy slow fix mid-tunnel near Baker Street
			fix(2100, 51.563, -0.279), // post-train, Wembley Park
		];
		const out = await annotateRailRuns(segs, points, lookup);
		// The train segment is at index 2.
		expect(out[2].wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});

	it("falls back to slow-fix lookup when there's no preceding stationary segment", async () => {
		// User boards directly from a previous walk (no stationary
		// before the train). Existing logic applies.
		const segs = [walking(1000, 1500), train(1500, 2000)];
		const points = [
			fix(1400, 51.523, -0.158), // slow fix near Baker Street
			fix(2100, 51.563, -0.279), // Wembley Park
		];
		const out = await annotateRailRuns(segs, points, lookup);
		expect(out[1].wayName).toBe("Baker Street → Wembley Park");
	});

	it("falls back to slow-fix lookup when the preceding stationary is not near any station", async () => {
		// Stationary at home (not a station). Walk to the station,
		// board. The home location doesn't resolve to a station —
		// don't claim it as the boarding station; fall back to slow-fix
		// lookup which would catch where the user actually entered.
		// Custom lookup returns empty for the home location (mirrors
		// real nearbyStations behaviour for non-station coords).
		const lookupWithEmpty = async (lat: number, lon: number) => {
			if (Math.abs(lat - 51.6) < 0.01 && Math.abs(lon - 0.0) < 0.01) return [];
			return [{ name: stationAt(lat, lon), subtype: "subway", distanceM: 50 }];
		};
		const segs = [stationaryAt(800, 1000), walking(1000, 1500), train(1500, 2000)];
		const points = [
			fix(900, 51.6, 0.0), // stationary at home (no station nearby)
			fix(1400, 51.523, -0.158), // slow fix near Baker Street
			fix(2100, 51.563, -0.279), // Wembley Park
		];
		const out = await annotateRailRuns(segs, points, lookupWithEmpty);
		expect(out[2].wayName).toBe("Baker Street → Wembley Park");
	});

	it("ignores a slow mid-train fix at endTs when picking the alighting station", async () => {
		// Pattern: a subway train decelerates approaching a non-
		// disembark station just as the velocity classifier's
		// detection window closes. The last fix in the train segment
		// lands at platform speed near that intermediate station, and
		// the old `p.ts >= endTs && slow(p)` rule picks THAT fix as
		// `after` → wrong alight station. Strict `p.ts > endTs` skips
		// the segment's own last fix and picks the first post-train
		// walking fix.
		const customStations = async (lat: number, lon: number) => {
			if (Math.abs(lat - 51.563) < 0.005 && Math.abs(lon - -0.279) < 0.005)
				return [{ name: "Wembley Park", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.524) < 0.005 && Math.abs(lon - -0.144) < 0.005)
				return [{ name: "Regent's Park", subtype: "subway", distanceM: 200 }];
			if (Math.abs(lat - 51.53) < 0.005 && Math.abs(lon - -0.124) < 0.005)
				return [{ name: "Kings Cross St Pancras", subtype: "subway", distanceM: 50 }];
			return [];
		};
		const segs = [train(1000, 1500), walking(1501, 1900)];
		const points: FilteredPoint[] = [
			{ ts: 1000, lat: 51.563, lon: -0.279, speed_kmh: 0, bearing: 0 },
			{ ts: 1500, lat: 51.524, lon: -0.144, speed_kmh: 1, bearing: 0 }, // slow mid-train near Regent's Park
			{ ts: 1700, lat: 51.53, lon: -0.124, speed_kmh: 0, bearing: 0 }, // walking at Kings Cross
		];
		const out = await annotateRailRuns(segs, points, customStations);
		expect(out[0].wayName).toBe("Wembley Park → Kings Cross St Pancras");
	});

	it("skips a decelerating-train fix at a non-disembark station after endTs", async () => {
		// Pattern: between segment endTs and the actual disembark, an
		// intermediate fix lands at an intermediate station coords with
		// speed 5-10 km/h — the train decelerating through a station
		// en route to the actual disembark. A 15 km/h `slow` threshold
		// treats that as post-train and picks the wrong (intermediate)
		// station as alighting. A tighter 5 km/h threshold distinguishes
		// a decelerating train (5-15 km/h) from a rider walking or
		// standing on a platform (< 5 km/h).
		const customStations = async (lat: number, lon: number) => {
			if (Math.abs(lat - 51.563) < 0.005 && Math.abs(lon - -0.279) < 0.005)
				return [{ name: "Wembley Park", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.526) < 0.005 && Math.abs(lon - -0.135) < 0.005)
				return [{ name: "Euston Square", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.53) < 0.005 && Math.abs(lon - -0.124) < 0.005)
				return [{ name: "Kings Cross St Pancras", subtype: "subway", distanceM: 50 }];
			return [];
		};
		const segs = [train(1000, 1500), walking(1501, 1900)];
		const points: FilteredPoint[] = [
			{ ts: 1000, lat: 51.563, lon: -0.279, speed_kmh: 0, bearing: 0 },
			{ ts: 1600, lat: 51.526, lon: -0.135, speed_kmh: 7.5, bearing: 0 }, // decelerating train through Euston Sq
			{ ts: 1700, lat: 51.53, lon: -0.124, speed_kmh: 1, bearing: 0 }, // disembarked at Kings Cross
		];
		const out = await annotateRailRuns(segs, points, customStations);
		expect(out[0].wayName).toBe("Wembley Park → Kings Cross St Pancras");
	});

	it("uses slowBefore's station when the rider walked a realistic distance from stationary", async () => {
		// Pattern: a 26-min Stationary segment near station A, then a
		// 15-min walk to station B (~1.4 km in 8 min, ≈ 10 km/h
		// brisk-but-realistic walking pace), then a train ride. The
		// old "preceding-stationary wins" rule would annotate boarding
		// at station A because that was the nearest station to the
		// Stationary segment. But the rider clearly walked to station
		// B — slowBefore is 1.4 km from the stationary endpoint at
		// human-walking pace, so it's a real new location (not the
		// mid-tunnel GPS noise the preceding-stationary rule was
		// designed to ignore). Trust slowBefore in this case.
		const customStations = async (lat: number, lon: number) => {
			if (Math.abs(lat - 51.53) < 0.005 && Math.abs(lon - -0.125) < 0.005)
				return [{ name: "Kings Cross St Pancras", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.524) < 0.005 && Math.abs(lon - -0.144) < 0.005)
				return [{ name: "Marylebone", subtype: "train_station", distanceM: 80 }];
			if (Math.abs(lat - 51.554) < 0.01 && Math.abs(lon - -0.25) < 0.01)
				return [{ name: "Wembley Stadium", subtype: "train_station", distanceM: 100 }];
			return [];
		};
		const segs = [stationaryAt(1560, 3120), walking(3120, 4020), train(4020, 4500)];
		const points = [
			fix(2000, 51.53, -0.125), // inside stationary at Work
			fix(3000, 51.53, -0.125), // last fix in stationary — KX area
			fix(3360, 51.531, -0.125), // walking, still near KX
			fix(3840, 51.524, -0.144), // late walking, Marylebone area (becomes slowBefore)
			fix(4600, 51.554, -0.25), // post-train, Wembley Stadium (ts > train endTs)
		];
		const out = await annotateRailRuns(segs, points, customStations);
		expect(out[2].wayName).toBe("Marylebone → Wembley Stadium");
	});

	it("extends boarding lookup backward through platform-train-platform fix patterns", async () => {
		// Bug pattern: the velocity classifier closes the train segment's
		// startTs too late, because windows-averaged over a stop-and-go
		// platform sequence look like "ambiguous walking" rather than
		// "train." The actual boarding fix lies several minutes before
		// the classifier's startTs, but slowBefore (which picks the
		// latest slow fix at-or-before startTs) lands at an intermediate
		// platform mid-ride. The result is the wrong boarding station.
		//
		// Synthetic platform-pattern: alternating slow/fast fixes over
		// ~8 minutes, starting at station A. The classifier-perceived
		// startTs lands at the last platform (station C), but the true
		// boarding was at station A.
		const fixWithSpeed = (ts: number, lat: number, lon: number, speedKmh: number): FilteredPoint => ({
			ts,
			lat,
			lon,
			speed_kmh: speedKmh,
			bearing: 0,
		});
		const stations = async (lat: number, lon: number) => {
			if (Math.abs(lat - 51.53) < 0.005 && Math.abs(lon - -0.125) < 0.005)
				return [{ name: "Station A", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.525) < 0.005 && Math.abs(lon - -0.135) < 0.005)
				return [{ name: "Station B", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.524) < 0.005 && Math.abs(lon - -0.144) < 0.005)
				return [{ name: "Station C", subtype: "subway", distanceM: 50 }];
			if (Math.abs(lat - 51.563) < 0.005 && Math.abs(lon - -0.279) < 0.005)
				return [{ name: "Station Z", subtype: "subway", distanceM: 50 }];
			return [];
		};
		// Classifier sees the train run as starting at ts=1500.
		const segs = [train(1500, 2000), walking(2001, 2100)];
		// But the actual platform-pattern starts at ts=1000 at Station A.
		const points: FilteredPoint[] = [
			fixWithSpeed(1000, 51.53, -0.125, 0.7), // BOARDING: Station A platform
			fixWithSpeed(1050, 51.53, -0.125, 7.7), // entering train at A
			fixWithSpeed(1150, 51.525, -0.135, 57.8), // mid-ride A→B
			fixWithSpeed(1200, 51.525, -0.135, 4.2), // platform at Station B (intermediate)
			fixWithSpeed(1300, 51.524, -0.144, 86.1), // mid-ride B→C
			fixWithSpeed(1400, 51.524, -0.144, 4.3), // platform at Station C (intermediate)
			fixWithSpeed(1500, 51.524, -0.144, 0.5), // last platform fix at start of train segment
			fixWithSpeed(2100, 51.563, -0.279, 0.5), // disembark at Station Z
		];
		const out = await annotateRailRuns(segs, points, stations);
		// Without the fix: slowBefore lands at one of the mid-train
		// platform fixes (ts=1400 or 1500 at Station C coords) and
		// boarding resolves to "Station C → Station Z" — wrong.
		// With the fix: backward walk through the platform pattern
		// finds the earliest slow fix (ts=1000) and boarding resolves
		// to "Station A → Station Z".
		expect(out[0].wayName).toBe("Station A → Station Z");
	});

	it("does not walk back across a previous train segment when picking boarding", async () => {
		// Previous train → stationary at Kings Cross (interchange) →
		// walking → new train. The most-recent stationary is the
		// interchange at Kings Cross; that's what we want. The earlier
		// train segment is fine — we stop walking back at any non-
		// stationary, non-walking segment, so the previous-train's
		// destination doesn't accidentally become the new train's
		// boarding station.
		const segs = [
			train(0, 500),
			stationaryAt(500, 700), // interchange at Kings Cross
			walking(700, 1000),
			train(1000, 1500),
		];
		const points = [
			fix(50, 51.5, -0.1),
			fix(600, 51.53, -0.125), // inside interchange stationary, Kings Cross
			fix(900, 51.52, -0.13), // walking
			fix(1600, 51.563, -0.279), // Wembley Park
		];
		const out = await annotateRailRuns(segs, points, lookup);
		// The new train run starts at segs[3]. After collapse the new
		// train run's annotation should reference Kings Cross.
		const lastTrain = out[out.length - 1];
		expect(lastTrain.wayName).toBe("Kings Cross St Pancras → Wembley Park");
	});
});

describe("shouldUseClusterAmenity", () => {
	// Per-cluster amenity_label from mining (Bairro Alto, Wasabi, etc.) is
	// the right label for a non-residential cluster. For a *residential*
	// cluster — one where Fitbit data shows you sleep there — the closest
	// amenity is the wrong concept (you're at the lodging, not at the
	// restaurant next door). This gate decides.
	const THRESHOLD = 5;

	const place = (
		overrides: Partial<{ displayName: string | null; sleepHours: number; amenityLabel: string | null }>,
	) => ({
		displayName: null,
		sleepHours: 0,
		amenityLabel: "Bairro Alto",
		...overrides,
	});

	it("returns true for a non-residential cluster with an amenity_label", () => {
		expect(shouldUseClusterAmenity(place({ sleepHours: 0, amenityLabel: "Bairro Alto" }), THRESHOLD)).toBe(true);
	});

	it("returns false when the cluster has no amenity_label", () => {
		expect(shouldUseClusterAmenity(place({ amenityLabel: null }), THRESHOLD)).toBe(false);
	});

	it("returns false for a residential cluster even when amenity_label is set", () => {
		// The Nijmegen hotel case: 118h dwell with sustained overnight
		// presence → sleep_hours well above threshold → amenity_label
		// "Zappa's" is the adjacent restaurant, not where the user is.
		// Address-based residential lookup should win instead.
		expect(shouldUseClusterAmenity(place({ sleepHours: 80, amenityLabel: "Zappa's" }), THRESHOLD)).toBe(false);
	});

	it("returns false when sleepHours is exactly at the threshold", () => {
		// Threshold is exclusive: >= threshold means residential.
		expect(shouldUseClusterAmenity(place({ sleepHours: THRESHOLD, amenityLabel: "X" }), THRESHOLD)).toBe(false);
	});

	it("returns true when sleepHours is just below the threshold", () => {
		expect(shouldUseClusterAmenity(place({ sleepHours: THRESHOLD - 0.01, amenityLabel: "X" }), THRESHOLD)).toBe(true);
	});

	it("returns false when the cluster is Home (Home/Work label takes priority)", () => {
		// Home/Work clusters are handled by a separate branch that names
		// them by user intent ("Home", "Work"). amenity_label is not used.
		expect(shouldUseClusterAmenity(place({ displayName: "Home", amenityLabel: "X" }), THRESHOLD)).toBe(false);
	});

	it("returns false when the cluster is Work", () => {
		expect(shouldUseClusterAmenity(place({ displayName: "Work", amenityLabel: "X" }), THRESHOLD)).toBe(false);
	});

	it("returns false for a null snappedTo (no cluster to consult)", () => {
		expect(shouldUseClusterAmenity(null, THRESHOLD)).toBe(false);
	});
});
