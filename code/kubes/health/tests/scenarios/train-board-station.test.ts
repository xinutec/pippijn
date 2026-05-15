/**
 * Scenario: a user walks past one or two stations on their way to a
 * further station, then boards. The boarding-station picker should
 * land at the station where the user actually stopped (the platform-
 * wait cluster), not at an earlier station they walked past.
 *
 * Reproduces today's prod case (anonymised): user walked past one
 * station at ~5–6 km/h, continued to another station, slowed to
 * near-stationary on the platform, then train. The current
 * `findBoardingPlatformFix` includes the whole walking approach in
 * the "platform chain" (its slow-cutoff is 8 km/h, which lets
 * brisk-walking fixes in), so the earliest chain member ends up
 * near the walked-past station. Boarding label = wrong station.
 *
 * The shape (timing in UTC; the prod sequence is a tighter version of
 * this — the test stretches gaps slightly so the chain rebuilds
 * across them are obvious).
 *
 *   walking past STATION_A:  fixes at ~5–7 km/h
 *   walking through middle:  fixes at ~5 km/h
 *   approaching STATION_B:   fixes at ~5 km/h slowing
 *   waiting on platform B:   ~0.1–1 km/h cluster (4–6 fixes)
 *   train kicks in:          first fast fix at ~70 km/h
 *
 * Fix: the boarding chain must require near-stationary fixes
 * (< BOARDING_STILL_KMH ≈ 3 km/h) rather than the looser
 * PLATFORM_SLOW_KMH (8 km/h). The earliest chain member is then
 * within the actual platform-wait cluster, near STATION_B.
 */

import { describe, expect, it } from "vitest";
import { findBoardingPlatformFix } from "../../src/geo/velocity.js";

const STATION_A: [number, number] = [51.5253, -0.1383]; // walked past
const STATION_B: [number, number] = [51.5258, -0.1359]; // actual boarding

// Synthetic fix sequence anchored at fixed timestamps. Times chosen
// so the train start is at boardTs+0 and prior fixes step back ~30 s
// each (close to today's prod cadence).
const boardTs = 1_700_000_000; // round number; absolute value doesn't matter

const fixes = [
	// 14 min before board: walking past STATION_A
	{ ts: boardTs - 14 * 60, lat: 51.5247, lon: -0.1383 + 0.0002, speed_kmh: 5.8 },
	{ ts: boardTs - 13 * 60, lat: 51.525, lon: -0.1383, speed_kmh: 5.2 },
	{ ts: boardTs - 12 * 60, lat: 51.5253, lon: -0.1379, speed_kmh: 6.3 }, // closest pass STATION_A
	{ ts: boardTs - 11 * 60, lat: 51.5254, lon: -0.1374, speed_kmh: 4.7 },
	// Walking eastward between stations
	{ ts: boardTs - 10 * 60, lat: 51.5255, lon: -0.1369, speed_kmh: 5.0 },
	{ ts: boardTs - 9 * 60, lat: 51.5256, lon: -0.1365, speed_kmh: 5.3 },
	// Approaching STATION_B
	{ ts: boardTs - 8 * 60, lat: 51.5257, lon: -0.1362, speed_kmh: 4.6 },
	{ ts: boardTs - 7 * 60, lat: 51.5258, lon: -0.136, speed_kmh: 3.9 },
	// Slowing onto the platform
	{ ts: boardTs - 6 * 60, lat: 51.5258, lon: -0.1359, speed_kmh: 1.0 },
	{ ts: boardTs - 5 * 60, lat: 51.5258, lon: -0.1359, speed_kmh: 0.2 }, // stopped
	{ ts: boardTs - 4 * 60, lat: 51.5258, lon: -0.1359, speed_kmh: 0.1 }, // stopped
	{ ts: boardTs - 3 * 60, lat: 51.5257, lon: -0.1359, speed_kmh: 2.5 }, // shuffling
	{ ts: boardTs - 2 * 60, lat: 51.5258, lon: -0.1359, speed_kmh: 0.1 }, // stopped
	{ ts: boardTs - 60, lat: 51.5258, lon: -0.1359, speed_kmh: 1.3 },
	// Train starts
	{ ts: boardTs, lat: 51.524, lon: -0.1437, speed_kmh: 69.9, bearing: 270 },
].map((p) => ({ ...p, bearing: p.bearing ?? 0 }));

function distMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

describe("scenario: walking past one station to board at another", () => {
	it("returns a fix near STATION_B (the actual platform-wait cluster), not STATION_A", () => {
		const result = findBoardingPlatformFix(fixes, boardTs);
		expect(result).not.toBeNull();
		if (!result) return;

		const dA = distMeters(result.lat, result.lon, STATION_A[0], STATION_A[1]);
		const dB = distMeters(result.lat, result.lon, STATION_B[0], STATION_B[1]);
		expect(
			dB < dA,
			`expected boarding fix nearer STATION_B than STATION_A; got dA=${Math.round(dA)}m dB=${Math.round(dB)}m`,
		).toBe(true);
		// And tighter: the chosen fix should be on the platform-wait
		// cluster, i.e. within ~50 m of STATION_B.
		expect(dB).toBeLessThan(50);
	});
});
