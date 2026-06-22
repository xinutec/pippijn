/**
 * Pedestrian trajectory smoother tests — pins the physical behaviour each
 * factor is supposed to produce (proposal:
 * 2026-06-pedestrian-trajectory-smoother.md).
 */

import { describe, expect, it } from "vitest";
import {
	type PedFix,
	type PedStep,
	smoothPedestrianTrajectory,
	type WalkableGeo,
} from "../src/geo/pedestrian-smooth.js";

const ORIGIN = 51.5;
// metres → degrees at this latitude
const dLat = (m: number): number => ORIGIN + m / 111_320;
const dLon = (m: number): number => -0.1 + m / (111_320 * Math.cos((ORIGIN * Math.PI) / 180));

function fix(ts: number, north: number, east: number, accuracy: number): PedFix {
	return { ts, lat: dLat(north), lon: dLon(east), accuracy };
}

/** metres between two lat/lon points */
function m(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const y = (b.lat - a.lat) * 111_320;
	const x = (b.lon - a.lon) * 111_320 * Math.cos((ORIGIN * Math.PI) / 180);
	return Math.hypot(x, y);
}
function pathLen(pts: ReadonlyArray<{ lat: number; lon: number }>): number {
	let t = 0;
	for (let i = 1; i < pts.length; i++) t += m(pts[i - 1], pts[i]);
	return t;
}

describe("smoothPedestrianTrajectory", () => {
	it("returns null for too few fixes", () => {
		expect(smoothPedestrianTrajectory([fix(0, 0, 0, 10), fix(15, 0, 10, 10)])).toBeNull();
	});

	it("a clean straight walk stays straight (and keeps its length)", () => {
		// 7 fixes due east, 10 m apart, good accuracy.
		const fixes = Array.from({ length: 7 }, (_, i) => fix(i * 15, 0, i * 10, 8));
		const r = smoothPedestrianTrajectory(fixes);
		expect(r).not.toBeNull();
		// midpoints stay on the line (north ≈ 0 → within a metre of the origin lat)
		for (const v of r?.path ?? []) expect(Math.abs(m(v, { lat: ORIGIN, lon: v.lon }))).toBeLessThan(2);
		expect(pathLen(r?.path ?? [])).toBeGreaterThan(55); // ~60 m, not collapsed
	});

	it("rejects a single far GPS outlier (heavy-tailed loss)", () => {
		// Straight east walk, but fix #3 is flung 80 m north with terrible accuracy.
		const fixes = [
			fix(0, 0, 0, 8),
			fix(15, 0, 10, 8),
			fix(30, 0, 20, 8),
			fix(45, 80, 30, 200),
			fix(60, 0, 40, 8),
			fix(75, 0, 50, 8),
			fix(90, 0, 60, 8),
		];
		const r = smoothPedestrianTrajectory(fixes);
		const outlier = r?.path[3];
		expect(outlier).toBeDefined();
		// The smoothed vertex should sit near the line (≪ 80 m), not at the spike.
		// (GPS-only here — no PDR/map; real walks crush it further.)
		expect(
			Math.abs(m(outlier as { lat: number; lon: number }, { lat: ORIGIN, lon: (outlier as { lon: number }).lon })),
		).toBeLessThan(25);
		// …and report itself as uncertain (poor fix).
		expect((outlier as { sigmaM: number }).sigmaM).toBeGreaterThan(8);
	});

	it("clamps endpoints to anchors", () => {
		const fixes = Array.from({ length: 6 }, (_, i) => fix(i * 15, 5, i * 12, 15));
		const r = smoothPedestrianTrajectory(fixes, {
			anchorStart: { lat: dLat(0), lon: dLon(0) },
			anchorEnd: { lat: dLat(0), lon: dLon(60) },
		});
		expect(m(r?.path[0] as { lat: number; lon: number }, { lat: dLat(0), lon: dLon(0) })).toBeLessThan(3);
		expect(m(r?.path.at(-1) as { lat: number; lon: number }, { lat: dLat(0), lon: dLon(60) })).toBeLessThan(3);
	});

	it("restores arc length from the pedometer when smoothing would shorten it (PDR)", () => {
		// An L-shaped walk — 50 m east, then 50 m north (true length ~100 m,
		// straight-line only ~71 m). Smoothness alone rounds the corner and
		// shortens the path; the pedometer (≈100 m) must pull the length back up.
		const fixes = [
			fix(0, 0, 0, 18),
			fix(15, 3, 17, 18),
			fix(30, -2, 34, 18),
			fix(45, 2, 50, 18), // the corner
			fix(60, 17, 52, 18),
			fix(75, 34, 49, 18),
			fix(90, 50, 50, 18),
		];
		const target = 100; // ~139 steps × 0.72 m
		const steps: PedStep[] = [
			{ ts: 0, steps: 93 },
			{ ts: 60, steps: 93 },
		];
		const withPdr = smoothPedestrianTrajectory(fixes, { steps, strideM: 0.72 });
		const noPdr = smoothPedestrianTrajectory(fixes);
		const lenWith = pathLen(withPdr?.path ?? []);
		const lenNo = pathLen(noPdr?.path ?? []);
		// PDR pushes the length up toward the pedometer truth…
		expect(lenWith).toBeGreaterThan(lenNo);
		// …and lands closer to it than smoothing alone.
		expect(Math.abs(lenWith - target)).toBeLessThan(Math.abs(lenNo - target));
	});

	it("soft map: pulls toward a footway in a corridor…", () => {
		// A footway 8 m north of a straight east walk whose fixes scatter ±6 m.
		const footway: WalkableGeo = {
			ways: [
				{
					osmId: 1,
					name: "Foot Path",
					subtype: "footway",
					coords: [
						[dLat(8), dLon(0)],
						[dLat(8), dLon(60)],
					],
				},
			],
		};
		const fixes = [
			fix(0, 8, 0, 15),
			fix(15, 2, 10, 15),
			fix(30, 14, 20, 15),
			fix(45, 3, 30, 15),
			fix(60, 13, 40, 15),
			fix(75, 8, 50, 15),
			fix(90, 8, 60, 15),
		];
		const withMap = smoothPedestrianTrajectory(fixes, { walkable: footway });
		const noMap = smoothPedestrianTrajectory(fixes);
		// Mean distance to the footway (north=8) should be smaller with the map on.
		const meanToPath = (r: ReturnType<typeof smoothPedestrianTrajectory>): number => {
			const ps = r?.path ?? [];
			return ps.reduce((acc, v) => acc + Math.abs(m(v, { lat: dLat(8), lon: v.lon })), 0) / ps.length;
		};
		expect(meanToPath(withMap)).toBeLessThan(meanToPath(noMap));
	});

	it("…and NO pull when the only path is far away (open ground / forest)", () => {
		// The footway is 60 m north — beyond the openness radius — so for a walk
		// down in open ground the map says nothing; path ≈ the no-map path.
		const far: WalkableGeo = {
			ways: [
				{
					osmId: 1,
					name: "Distant Path",
					subtype: "footway",
					coords: [
						[dLat(60), dLon(0)],
						[dLat(60), dLon(60)],
					],
				},
			],
		};
		const fixes = [
			fix(0, 0, 0, 15),
			fix(15, 2, 10, 15),
			fix(30, -2, 20, 15),
			fix(45, 1, 30, 15),
			fix(60, -1, 40, 15),
			fix(75, 1, 50, 15),
			fix(90, 0, 60, 15),
		];
		const withFar = smoothPedestrianTrajectory(fixes, { walkable: far });
		const noMap = smoothPedestrianTrajectory(fixes);
		for (let i = 0; i < (noMap?.path.length ?? 0); i++) {
			expect(
				m(withFar?.path[i] as { lat: number; lon: number }, noMap?.path[i] as { lat: number; lon: number }),
			).toBeLessThan(0.5);
		}
	});

	it("…but exerts NO pull inside an open zone (free in a park)", () => {
		// Same footway, but the whole area is an open zone polygon → map weight 0,
		// so the path is identical with and without the map.
		const open: WalkableGeo = {
			ways: [
				{
					osmId: 1,
					name: "Foot Path",
					subtype: "footway",
					coords: [
						[dLat(8), dLon(0)],
						[dLat(8), dLon(60)],
					],
				},
			],
			openZones: [
				[
					{ lat: dLat(-50), lon: dLon(-50) },
					{ lat: dLat(-50), lon: dLon(110) },
					{ lat: dLat(60), lon: dLon(110) },
					{ lat: dLat(60), lon: dLon(-50) },
				],
			],
		};
		const fixes = [
			fix(0, 0, 0, 15),
			fix(15, 1, 10, 15),
			fix(30, -1, 20, 15),
			fix(45, 0, 30, 15),
			fix(60, 1, 40, 15),
			fix(75, 0, 50, 15),
			fix(90, 0, 60, 15),
		];
		const withOpen = smoothPedestrianTrajectory(fixes, { walkable: open });
		const noMap = smoothPedestrianTrajectory(fixes);
		// Identical: the open zone nulls the map factor everywhere.
		for (let i = 0; i < (noMap?.path.length ?? 0); i++) {
			expect(
				m(withOpen?.path[i] as { lat: number; lon: number }, noMap?.path[i] as { lat: number; lon: number }),
			).toBeLessThan(0.5);
		}
	});
});
