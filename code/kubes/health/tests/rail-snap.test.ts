/**
 * Rail-snap: snapping scattered GPS fixes onto an identified rail track.
 *
 * Once a journey is confidently classified as a train run on a known
 * line, the coarse mid-tunnel fixes can be projected onto the actual
 * track polyline instead of drawn as a zigzag. This file tests the
 * three pure pieces of that:
 *
 *   - `projectOntoPolyline` — foot-of-perpendicular of a point onto a
 *     polyline, with distance-along and perpendicular-offset.
 *   - `stitchWays` — join the individual OSM way-segments of a line
 *     into one connected, correctly-oriented route polyline.
 *   - `snapFixesToRoute` — map-match a time-ordered run of fixes onto
 *     a route, forcing monotonic forward progress and densifying the
 *     output with the route's own vertices so it hugs the track.
 *
 * All coordinates are synthetic, anchored at (50.0, 5.0). Distances
 * are built in metres east/north of that anchor via `at()`.
 */

import { describe, expect, it } from "vitest";
import {
	annotateSnappedPaths,
	type LatLon,
	parseRailLine,
	projectOntoPolyline,
	type SnapFix,
	snapFixesToRoute,
	stitchWays,
} from "../src/geo/rail-snap.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

const LAT_DEG_PER_M = 1 / 111_000;
const LON_DEG_PER_M = 1 / (111_000 * Math.cos((50 * Math.PI) / 180));

/** A point `metresNorth`/`metresEast` from the synthetic anchor. */
function at(metresNorth: number, metresEast: number): LatLon {
	return { lat: 50.0 + metresNorth * LAT_DEG_PER_M, lon: 5.0 + metresEast * LON_DEG_PER_M };
}

function metres(a: LatLon, b: LatLon): number {
	const dLat = (b.lat - a.lat) / LAT_DEG_PER_M;
	const dLon = (b.lon - a.lon) / LON_DEG_PER_M;
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

describe("projectOntoPolyline", () => {
	it("returns null for a degenerate polyline", () => {
		expect(projectOntoPolyline(at(0, 0), [])).toBeNull();
		expect(projectOntoPolyline(at(0, 0), [at(0, 0)])).toBeNull();
	});

	it("drops a point perpendicularly onto the nearest segment", () => {
		// Route runs due east, 0 → 1000 m. A point 20 m north of the
		// 500 m mark snaps to the 500 m mark with a 20 m offset.
		const route = [at(0, 0), at(0, 1000)];
		const p = projectOntoPolyline(at(20, 500), route);
		expect(p).not.toBeNull();
		if (!p) return;
		expect(metres(p, at(0, 500))).toBeLessThan(2);
		expect(p.distAlongM).toBeCloseTo(500, 0);
		expect(p.offsetM).toBeCloseTo(20, 0);
		expect(p.segIndex).toBe(0);
	});

	it("clamps a point beyond the start to the first vertex", () => {
		const route = [at(0, 0), at(0, 1000)];
		const p = projectOntoPolyline(at(5, -100), route);
		expect(p).not.toBeNull();
		if (!p) return;
		expect(metres(p, at(0, 0))).toBeLessThan(2);
		expect(p.distAlongM).toBeCloseTo(0, 0);
	});

	it("picks the nearer leg of an L-shaped route", () => {
		// East leg 0→1000, then north leg 0→1000 at east=1000.
		const route = [at(0, 0), at(0, 1000), at(1000, 1000)];
		// A point near the north leg, far from the east leg.
		const p = projectOntoPolyline(at(600, 980), route);
		expect(p).not.toBeNull();
		if (!p) return;
		expect(p.segIndex).toBe(1);
		expect(metres(p, at(600, 1000))).toBeLessThan(2);
		// distance-along = full east leg (1000) + 600 up the north leg.
		expect(p.distAlongM).toBeCloseTo(1600, -1);
	});
});

describe("stitchWays", () => {
	it("joins two ways that share an endpoint", () => {
		const wayA = [at(0, 0), at(0, 500)];
		const wayB = [at(0, 500), at(0, 1000)];
		const out = stitchWays([wayA, wayB]);
		expect(out).toHaveLength(1);
		expect(out[0]).toHaveLength(3);
		expect(metres(out[0][0], at(0, 0))).toBeLessThan(2);
		expect(metres(out[0][2], at(0, 1000))).toBeLessThan(2);
	});

	it("flips a way whose orientation is reversed at the join", () => {
		const wayA = [at(0, 0), at(0, 500)];
		// wayB shares the 500 m point but is stored end-first.
		const wayB = [at(0, 1000), at(0, 500)];
		const out = stitchWays([wayA, wayB]);
		expect(out).toHaveLength(1);
		expect(out[0]).toHaveLength(3);
		expect(metres(out[0][0], at(0, 0))).toBeLessThan(2);
		expect(metres(out[0][2], at(0, 1000))).toBeLessThan(2);
	});

	it("keeps disconnected ways as separate components, longest first", () => {
		const longWay = [at(0, 0), at(0, 500), at(0, 1000)];
		const farWay = [at(5000, 5000), at(5000, 5200)];
		const out = stitchWays([farWay, longWay]);
		expect(out).toHaveLength(2);
		expect(out[0]).toHaveLength(3);
		expect(out[1]).toHaveLength(2);
	});
});

describe("snapFixesToRoute", () => {
	const fix = (ts: number, p: LatLon): SnapFix => ({ ts, lat: p.lat, lon: p.lon });

	it("pulls scattered fixes onto the track", () => {
		const route = [at(0, 0), at(0, 1000)];
		const fixes = [fix(0, at(40, 100)), fix(60, at(-55, 500)), fix(120, at(30, 900))];
		const snapped = snapFixesToRoute(fixes, route);
		expect(snapped.length).toBeGreaterThan(0);
		// Every output point lies on the route (offset ~0).
		for (const s of snapped) {
			const proj = projectOntoPolyline(s, route);
			expect(proj?.offsetM ?? 999).toBeLessThan(1);
		}
	});

	it("forces monotonic forward progress despite a backward-scattered fix", () => {
		const route = [at(0, 0), at(0, 1000)];
		// Third fix scatters back to the 400 m mark after the 600 m mark.
		const fixes = [fix(0, at(0, 100)), fix(60, at(0, 600)), fix(90, at(0, 400)), fix(150, at(0, 900))];
		const snapped = snapFixesToRoute(fixes, route);
		const along = snapped.map((s) => projectOntoPolyline(s, route)?.distAlongM ?? Number.NaN);
		for (let i = 1; i < along.length; i++) {
			expect(along[i]).toBeGreaterThanOrEqual(along[i - 1] - 1);
		}
		// The backward fix is clamped forward, not snapped to 400 m.
		expect(Math.max(...along)).toBeCloseTo(900, -1);
	});

	it("densifies output with the route's own corner vertices", () => {
		// L-shaped route; fixes only near the two far ends. The output
		// must round the corner via the route vertex, not cut across it.
		const route = [at(0, 0), at(0, 1000), at(1000, 1000)];
		const fixes = [fix(100, at(10, 200)), fix(900, at(800, 990))];
		const snapped = snapFixesToRoute(fixes, route);
		const corner = snapped.find((s) => metres(s, at(0, 1000)) < 2);
		expect(corner).toBeDefined();
		// Corner ts is interpolated by distance: ~800 m of ~1600 m
		// travelled → roughly mid-way through the 100→900 s window.
		expect(corner?.ts ?? 0).toBeGreaterThan(300);
		expect(corner?.ts ?? 0).toBeLessThan(700);
	});

	it("returns empty for an empty fix list or a degenerate route", () => {
		expect(snapFixesToRoute([], [at(0, 0), at(0, 100)])).toEqual([]);
		expect(snapFixesToRoute([fix(0, at(0, 0))], [at(0, 0)])).toEqual([]);
	});

	it("keeps output timestamps non-decreasing", () => {
		const route = [at(0, 0), at(0, 1000)];
		const fixes = [fix(10, at(0, 100)), fix(70, at(0, 500)), fix(130, at(0, 900))];
		const snapped = snapFixesToRoute(fixes, route);
		for (let i = 1; i < snapped.length; i++) {
			expect(snapped[i].ts).toBeGreaterThanOrEqual(snapped[i - 1].ts);
		}
	});

	it("orients the route to the direction of travel", () => {
		// Route is stored west→east, but the fixes travel east→west.
		// The matcher must reverse the route so progress stays forward
		// instead of collapsing every fix onto the start vertex.
		const route = [at(0, 0), at(0, 1000)];
		const fixes = [fix(0, at(0, 900)), fix(60, at(0, 500)), fix(120, at(0, 100))];
		const snapped = snapFixesToRoute(fixes, route);
		expect(snapped.length).toBeGreaterThanOrEqual(2);
		// Output runs east→west: first point is east of the last.
		expect(snapped[0].lon).toBeGreaterThan(snapped[snapped.length - 1].lon);
		for (const s of snapped) {
			expect(projectOntoPolyline(s, route)?.offsetM ?? 999).toBeLessThan(1);
		}
	});
});

function seg(partial: Partial<EnrichedSegment> & { startTs: number; endTs: number }): EnrichedSegment {
	return {
		mode: "walking",
		confidence: 0.8,
		confidenceMargin: 3,
		avgSpeed: 5,
		maxSpeed: 7,
		linearity: 0.6,
		pointCount: 20,
		...partial,
	};
}

describe("parseRailLine", () => {
	it("extracts the line from a station-pair wayName's ` · ` suffix", () => {
		expect(parseRailLine("Aaa → Bbb · North London line")).toBe("North London line");
	});

	it("handles a station name that itself contains an ampersand", () => {
		expect(parseRailLine("Aaa & Ccc → Bbb · Jubilee")).toBe("Jubilee");
	});

	it("returns null when there is no line suffix", () => {
		expect(parseRailLine("Aaa → Bbb")).toBeNull();
		expect(parseRailLine(undefined)).toBeNull();
		expect(parseRailLine("")).toBeNull();
	});
});

describe("annotateSnappedPaths", () => {
	// A dense synthetic line running due east, the way OSM would store it.
	const line = [at(0, 0), at(0, 200), at(0, 400), at(0, 600), at(0, 800), at(0, 1000)];
	const lookupFor =
		(name: string, ways: LatLon[][]) =>
		async (_bbox: unknown, lineName: string): Promise<Array<{ coords: LatLon[] }>> =>
			lineName === name ? ways.map((w) => ({ coords: w })) : [];
	/** A linesLookup stub that always returns the given line set. */
	const linesAlways =
		(...names: string[]) =>
		async (): Promise<Set<string>> =>
			new Set(names);
	const noLines = async (): Promise<Set<string>> => new Set<string>();

	const trainFixes: SnapFix[] = [
		{ ts: 1100, ...at(40, 100) },
		{ ts: 1300, ...at(-30, 400) },
		{ ts: 1600, ...at(50, 700) },
		{ ts: 1900, ...at(-20, 950) },
	];

	it("attaches a snapped path to a confident train segment on a known line", async () => {
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", railLine: "TestLine" })];
		const out = await annotateSnappedPaths(segments, trainFixes, lookupFor("TestLine", [line]), noLines);
		expect(out[0].snappedPath).toBeDefined();
		expect((out[0].snappedPath ?? []).length).toBeGreaterThanOrEqual(2);
		for (const p of out[0].snappedPath ?? []) {
			expect(projectOntoPolyline(p, line)?.offsetM ?? 999).toBeLessThan(2);
		}
	});

	it("resolves the line from the wayName when the railLine field is unset", async () => {
		// annotateRailRuns labels overground runs "A → B · Line" but
		// never fills railLine — the line must be recovered from there.
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", wayName: "Aaa → Bbb · TestLine" })];
		const out = await annotateSnappedPaths(segments, trainFixes, lookupFor("TestLine", [line]), noLines);
		expect(out[0].snappedPath).toBeDefined();
		expect(out[0].railLine).toBe("TestLine");
	});

	it("mines the line via linesLookup when the wayName carries none", async () => {
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", wayName: "Aaa → Bbb" })];
		const out = await annotateSnappedPaths(
			segments,
			trainFixes,
			lookupFor("TestLine", [line]),
			linesAlways("TestLine"),
		);
		expect(out[0].snappedPath).toBeDefined();
		expect(out[0].railLine).toBe("TestLine");
	});

	it("leaves a train segment with no resolvable line untouched", async () => {
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", wayName: "Aaa → Bbb" })];
		const out = await annotateSnappedPaths(segments, trainFixes, lookupFor("TestLine", [line]), noLines);
		expect(out[0].snappedPath).toBeUndefined();
	});

	it("leaves non-train segments untouched", async () => {
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "walking", railLine: "TestLine" })];
		const out = await annotateSnappedPaths(segments, trainFixes, lookupFor("TestLine", [line]), noLines);
		expect(out[0].snappedPath).toBeUndefined();
	});

	it("leaves the segment untouched when the line has no OSM geometry", async () => {
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", railLine: "TestLine" })];
		const out = await annotateSnappedPaths(segments, trainFixes, lookupFor("OtherLine", [line]), noLines);
		expect(out[0].snappedPath).toBeUndefined();
	});

	it("rejects a route that does not fit the fixes (wrong line guard)", async () => {
		// The geometry lookup returns a line tens of km away from the
		// fixes — a mis-identified line. The snapped path must not be
		// attached: a confidently-wrong line is worse than no snap.
		const farLine = [at(60_000, 0), at(60_000, 1000)];
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", railLine: "TestLine" })];
		const out = await annotateSnappedPaths(segments, trainFixes, lookupFor("TestLine", [farLine]), noLines);
		expect(out[0].snappedPath).toBeUndefined();
	});

	it("picks the stitched component the fixes hug, not the longest", async () => {
		// A line's geometry stitches into several disconnected pieces.
		// The longest is far away; a shorter one runs along the fixes.
		// The snap must follow the near piece, not merely the longest.
		const farLong = [at(60_000, 0), at(60_000, 500), at(60_000, 1000), at(60_000, 1500), at(60_000, 2000)];
		const nearShort = [at(0, 0), at(0, 400), at(0, 800), at(0, 1100)];
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", railLine: "TestLine" })];
		const out = await annotateSnappedPaths(segments, trainFixes, lookupFor("TestLine", [farLong, nearShort]), noLines);
		expect(out[0].snappedPath).toBeDefined();
		for (const p of out[0].snappedPath ?? []) {
			expect(projectOntoPolyline(p, nearShort)?.offsetM ?? 999).toBeLessThan(2);
		}
	});

	it("ignores a wildly-inaccurate outlier fix", async () => {
		// A fix with a multi-km accuracy radius carries no usable
		// position. Left in, it would balloon the route-fit offsets and
		// suppress the snap; it must be dropped before snapping.
		const fixes: SnapFix[] = [...trainFixes, { ts: 1500, ...at(80_000, 80_000), accuracy: 9000 }];
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", railLine: "TestLine" })];
		const out = await annotateSnappedPaths(segments, fixes, lookupFor("TestLine", [line]), noLines);
		expect(out[0].snappedPath).toBeDefined();
		expect((out[0].snappedPath ?? []).length).toBeGreaterThanOrEqual(2);
	});

	// Accurate fixes (sub-100 m accuracy) hug the line; coarse
	// cell-network fixes scatter ~3 km off it.
	const goodOnTrack: SnapFix[] = [100, 250, 400, 550, 700, 850].map((east, i) => ({
		ts: 1100 + i * 100,
		...at(15, east),
		accuracy: 30,
	}));
	const coarseOffTrack: SnapFix[] = Array.from({ length: 10 }, (_, i) => ({
		ts: 1120 + i * 70,
		...at(3000, 100 + i * 80),
		accuracy: 400,
	}));

	it("snaps from the accurate fixes when coarse ones scatter far off-track", async () => {
		// 6 accurate fixes on the line + 10 coarse fixes 3 km off it.
		// The snap must follow the accurate backbone — the coarse
		// fixes' median offset alone would fail the route-fit guard.
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", railLine: "TestLine" })];
		const out = await annotateSnappedPaths(
			segments,
			[...goodOnTrack, ...coarseOffTrack],
			lookupFor("TestLine", [line]),
			noLines,
		);
		expect(out[0].snappedPath).toBeDefined();
		for (const p of out[0].snappedPath ?? []) {
			expect(projectOntoPolyline(p, line)?.offsetM ?? 999).toBeLessThan(2);
		}
	});

	it("falls back to all fixes when there is no accurate-fix backbone", async () => {
		// Only 4 accurate fixes — below the backbone threshold — so the
		// coarse fixes are kept and their scatter fails the guard.
		const segments = [seg({ startTs: 1000, endTs: 2000, mode: "train", railLine: "TestLine" })];
		const out = await annotateSnappedPaths(
			segments,
			[...goodOnTrack.slice(0, 4), ...coarseOffTrack],
			lookupFor("TestLine", [line]),
			noLines,
		);
		expect(out[0].snappedPath).toBeUndefined();
	});
});
