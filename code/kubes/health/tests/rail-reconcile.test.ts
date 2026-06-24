/**
 * reconcileAdjacentRailLegs — a physical constraint: two train legs
 * that are back-to-back in the segment sequence, with nothing between
 * them, must share a station. You cannot step off one train and
 * instantly be on another at a different station. Where leg A's
 * alighting and leg B's boarding disagree, leg B is rewritten to board
 * where leg A alighted.
 */

import { describe, expect, it } from "vitest";
import { assembleRailJourney, parseRailWayName, reconcileAdjacentRailLegs } from "../src/geo/passes/rail-reconcile.js";
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

describe("assembleRailJourney", () => {
	/** Minimal OsmAdapter slice: `linesAtPoint` is routed by the leg centroid's
	 *  integer latitude (a test tag), `stationsOnLine` from a name→stations map. */
	function osmStub(
		linesByLatTag: Record<number, string[]>,
		stationsByLine: Record<string, string[]>,
	): {
		linesAtPoint: (lat: number, lon: number, r?: number) => Promise<Set<string>>;
		stationsOnLine: (l: string) => Promise<{ name: string; lat: number; lon: number }[]>;
	} {
		return {
			linesAtPoint: async (lat) => new Set(linesByLatTag[Math.round(lat)] ?? []),
			stationsOnLine: async (line) => (stationsByLine[line] ?? []).map((name) => ({ name, lat: 0, lon: 0 })),
		};
	}

	const MET = ["Wembley Park", "Finchley Road", "Baker Street", "Euston Square"];

	it("collapses a one-line ride fragmented into 3 train legs + slivers into one leg", async () => {
		// Wembley Park → Euston Square on the Metropolitan line, shattered by the
		// GPS surfacing mid-tunnel into three train legs with interchange slivers.
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Finchley Road", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 12, { centroidLat: 1, centroidLon: 0 }),
			seg("train", 12, 17, { wayName: "Finchley Road → Baker Street", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 17, 22, { centroidLat: 1, centroidLon: 0 }),
			seg("train", 22, 33, { wayName: "Baker Street → Euston Square", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Wembley Park → Euston Square · Metropolitan Line");
		expect(trains[0].startTs).toBe(0);
		expect(trains[0].endTs).toBe(33 * 60);
	});

	it("absorbs a mis-moded non-train middle (driving) into the one-line ride", async () => {
		// Without the tube-leg-recovery patch the surfaced middle is `driving`; the
		// topology (all four stations on one line) still recovers one tube ride.
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Finchley Road", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 12, { centroidLat: 1, centroidLon: 0 }),
			seg("driving", 12, 17, { centroidLat: 1, centroidLon: 0 }),
			seg("walking", 17, 22, { centroidLat: 1, centroidLon: 0 }),
			seg("train", 22, 33, { wayName: "Baker Street → Euston Square", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train" || s.refinedMode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Wembley Park → Euston Square · Metropolitan Line");
	});

	it("does NOT merge a real line-change interchange (no single line serves all stations)", async () => {
		// Victoria → King's Cross (Victoria line), change, King's Cross → Euston
		// Square (Met). No single line serves {Victoria, King's Cross, Euston Sq}.
		const segs = [
			seg("train", 0, 10, { wayName: "Victoria → King's Cross · Victoria Line", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 14, { centroidLat: 2, centroidLon: 0 }),
			seg("train", 14, 20, {
				wayName: "King's Cross → Euston Square · Metropolitan Line",
				centroidLat: 2,
				centroidLon: 0,
			}),
		];
		const osm = osmStub(
			{ 1: ["Victoria Line"], 2: ["Metropolitan Line"] },
			{ "Victoria Line": ["Victoria", "King's Cross"], "Metropolitan Line": ["King's Cross", "Euston Square"] },
		);
		const out = await assembleRailJourney([...segs], [], osm);
		expect(out.filter((s) => s.mode === "train")).toHaveLength(2);
	});

	it("does NOT merge across a long stop (a real stopover, not a surfacing sliver)", async () => {
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Finchley Road", centroidLat: 1, centroidLon: 0 }),
			seg("stationary", 10, 40, { centroidLat: 1, centroidLon: 0 }), // 30-min stop — got off
			seg("train", 40, 50, { wayName: "Finchley Road → Baker Street", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		expect(out.filter((s) => s.mode === "train")).toHaveLength(2);
	});

	it("absorbs a long mis-moded transit middle (motorised peak) into the one-line ride", async () => {
		// 2026-06-24 Wembley Park → Euston Square: the Finchley Rd → Baker St tunnel
		// surfaced as a 13-min "walking" segment — over the 10-min sliver cap, so the
		// duration rule alone leaves the ride fragmented. But its peak is tube speed
		// (84 km/h), not a street walk. The single through-line serving all four
		// stations recovers one ride; the motorised peak is what tells a mis-moded
		// tunnel apart from a genuine walk between two separate rides.
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Finchley Road", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 23, { centroidLat: 1, centroidLon: 0, maxSpeed: 84 }),
			seg("train", 23, 28, { wayName: "Baker Street → Euston Square", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].wayName).toBe("Wembley Park → Euston Square · Metropolitan Line");
	});

	it("does NOT absorb a long walking-pace middle (a real walk between two separate rides)", async () => {
		// Same shape, but the 13-min middle peaks at walking pace — the rider got off,
		// walked on the street between two same-line stations, and boarded again. Two
		// distinct rides; the run must break despite a single line serving all stations.
		const segs = [
			seg("train", 0, 10, { wayName: "Wembley Park → Finchley Road", centroidLat: 1, centroidLon: 0 }),
			seg("walking", 10, 23, { centroidLat: 1, centroidLon: 0, maxSpeed: 8 }),
			seg("train", 23, 28, { wayName: "Baker Street → Euston Square", centroidLat: 1, centroidLon: 0 }),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		expect(out.filter((s) => s.mode === "train")).toHaveLength(2);
	});

	it("leaves a single train leg untouched", async () => {
		const segs = [
			seg("train", 0, 20, {
				wayName: "Wembley Park → Euston Square · Metropolitan Line",
				centroidLat: 1,
				centroidLon: 0,
			}),
		];
		const osm = osmStub({ 1: ["Metropolitan Line"] }, { "Metropolitan Line": MET });
		const out = await assembleRailJourney([...segs], [], osm);
		expect(out).toHaveLength(1);
		expect(out[0].wayName).toBe("Wembley Park → Euston Square · Metropolitan Line");
	});
});
