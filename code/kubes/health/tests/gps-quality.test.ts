/**
 * GPS quality-control pre-filter.
 *
 * Underground (tube, deep buildings) the phone falls back to cell-tower
 * triangulation and emits positions that are *wrong*, not just noisy —
 * teleporting kilometres and back. No smoothing filter recovers a true
 * trajectory from that. The principled answer is to discard the
 * incoherent run entirely and let the downstream gap-inference treat
 * it as missing data.
 *
 * `qualityFilterGps` walks the raw fixes with an "anchor" (the last
 * kept fix). A fix reachable from the anchor at a plausible speed is
 * kept and becomes the new anchor. A fix that is NOT reachable starts
 * a suspected garbage run: we scan forward for the first later fix
 * that IS reachable from the anchor (the surfacing point) and drop
 * everything between. If no such bridge exists within the window the
 * run is genuine sustained fast travel (plane, high-speed rail) — those
 * fixes are kept.
 *
 * All test coordinates are synthetic, anchored at (50.0, 5.0).
 */

import { describe, expect, it } from "vitest";
import { qualityFilterGps } from "../src/geo/gps-quality.js";
import type { GpsPoint } from "../src/geo/kalman.js";

const LAT_DEG_PER_M = 1 / 111_000;
const LON_DEG_PER_M = 1 / (111_000 * Math.cos((50 * Math.PI) / 180));

/** A fix `metresEast`/`metresNorth` from the synthetic anchor (50.0, 5.0). */
function fix(ts: number, metresNorth: number, metresEast: number, accuracy = 20): GpsPoint {
	return {
		ts,
		lat: 50.0 + metresNorth * LAT_DEG_PER_M,
		lon: 5.0 + metresEast * LON_DEG_PER_M,
		accuracy,
	};
}

describe("qualityFilterGps", () => {
	it("passes a clean walking track through unchanged", () => {
		// 12 fixes, ~5 km/h east, 15 s apart (~21 m per step). All coherent.
		const fixes: GpsPoint[] = [];
		for (let i = 0; i < 12; i++) fixes.push(fix(1000 + i * 15, 0, i * 21));
		const result = qualityFilterGps(fixes);
		expect(result).toHaveLength(12);
		expect(result).toEqual(fixes);
	});

	it("drops a single GPS teleport spike", () => {
		// 6 clean fixes, one fix teleporting 2.5 km off, 6 clean fixes.
		const fixes: GpsPoint[] = [];
		for (let i = 0; i < 6; i++) fixes.push(fix(1000 + i * 15, 0, i * 21));
		const spikeTs = 1000 + 6 * 15;
		fixes.push(fix(spikeTs, 2500, 2500)); // teleport
		for (let i = 0; i < 6; i++) fixes.push(fix(1000 + 7 * 15 + i * 15, 0, (6 + i) * 21));
		const result = qualityFilterGps(fixes);
		expect(result).toHaveLength(12);
		expect(result.some((p) => p.ts === spikeTs)).toBe(false);
	});

	it("drops a multi-fix underground garbage run, leaving an internally coherent track", () => {
		// Stationary at station A (8 fixes), then a run of thrashing garbage
		// fixes while underground (each one kilometres off, incoherent with
		// its neighbours), then the user surfaces at station B (~3 km away,
		// ~8 min later) and walks (8 fixes).
		const fixes: GpsPoint[] = [];
		for (let i = 0; i < 8; i++) fixes.push(fix(1000 + i * 15, 0, 0)); // station A
		const tunnelStart = 1000 + 8 * 15;
		// Garbage: each fix thrashes kilometres around, incoherently.
		const garbageOffsets = [
			[2600, -900],
			[-1800, 2400],
			[3100, 1200],
			[-2200, -1500],
			[900, 3000],
			[-2800, 600],
		];
		garbageOffsets.forEach(([n, e], k) => {
			fixes.push(fix(tunnelStart + k * 40, n, e));
		});
		const surfaceTs = tunnelStart + 8 * 60;
		for (let i = 0; i < 8; i++) fixes.push(fix(surfaceTs + i * 15, 0, 3000 + i * 21));
		const result = qualityFilterGps(fixes);

		// Invariant: the surviving stream is internally coherent — no
		// consecutive kept pair implies a physically impossible speed.
		// That's the real contract: the Kalman filter downstream only
		// ever sees a track it can smooth.
		for (let k = 1; k < result.length; k++) {
			const a = result[k - 1];
			const b = result[k];
			const dLatM = (b.lat - a.lat) * 111_320;
			const dLonM = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
			const speed = (Math.sqrt(dLatM ** 2 + dLonM ** 2) / (b.ts - a.ts)) * 3.6;
			expect(speed, `kept pair ${a.ts}->${b.ts} implies ${speed.toFixed(0)} km/h`).toBeLessThanOrEqual(160);
		}
		// Every clean station fix survives — QC only drops garbage.
		for (let i = 0; i < 8; i++) {
			expect(
				result.some((p) => p.ts === 1000 + i * 15),
				`station A fix ${i} dropped`,
			).toBe(true);
			expect(
				result.some((p) => p.ts === surfaceTs + i * 15),
				`station B fix ${i} dropped`,
			).toBe(true);
		}
		// The bulk of the garbage run is gone (the wildly-thrashing fixes
		// that imply hundreds of km/h between neighbours).
		expect(result.length).toBeLessThan(20);
	});

	it("keeps sustained fast travel (a plane), which has no coherent bridge", () => {
		// A plane: 14 fixes marching coherently NE at ~800 km/h, 30 s apart
		// (~6.67 km per step). Every fix is "unreachable" from the previous
		// by the plausible-speed test, but there is no bridge fix reachable
		// from the pre-flight anchor — so the run is genuine fast travel and
		// must be kept.
		const fixes: GpsPoint[] = [];
		// 4 slow pre-flight fixes
		for (let i = 0; i < 4; i++) fixes.push(fix(1000 + i * 30, 0, i * 40));
		// 14 cruise fixes
		const cruiseStart = 1000 + 4 * 30;
		for (let i = 0; i < 14; i++) fixes.push(fix(cruiseStart + i * 30, i * 6670, i * 6670));
		const result = qualityFilterGps(fixes);
		// Nothing dropped — a coherent fast run is real travel.
		expect(result).toHaveLength(18);
	});

	it("returns short inputs unchanged", () => {
		const two = [fix(1000, 0, 0), fix(1015, 0, 21)];
		expect(qualityFilterGps(two)).toEqual(two);
		expect(qualityFilterGps([])).toEqual([]);
	});
});
