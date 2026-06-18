/**
 * Platform-wait absorption.
 *
 * A short stationary segment immediately before a train, sitting at the
 * train's boarding station, is the wait on the platform — it should be
 * folded into the train run, not left as a standalone stay (which the
 * place-assigner then mislabels with the nearest focus place).
 *
 * All coordinates are synthetic, anchored at (50.0, 5.0): station Alpha
 * at the anchor, station Beta 3 km north.
 */

import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { NearbyStation } from "../src/geo/osm.js";
import { absorbBoardingPlatform } from "../src/geo/passes/rail-absorbers.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

const LAT_DEG_PER_M = 1 / 111_000;
const LON_DEG_PER_M = 1 / (111_000 * Math.cos((50 * Math.PI) / 180));

function at(metresNorth: number, metresEast: number): { lat: number; lon: number } {
	return { lat: 50.0 + metresNorth * LAT_DEG_PER_M, lon: 5.0 + metresEast * LON_DEG_PER_M };
}

function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const dLat = (lat2 - lat1) / LAT_DEG_PER_M;
	const dLon = (lon2 - lon1) / LON_DEG_PER_M;
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

const STATIONS = [
	{ name: "Alpha", north: 0, east: 0 },
	{ name: "Beta", north: 3000, east: 0 },
];

const stationsLookup = async (lat: number, lon: number): Promise<NearbyStation[]> =>
	STATIONS.map((s) => {
		const p = at(s.north, s.east);
		return { name: s.name, subtype: "subway", distanceM: metres(lat, lon, p.lat, p.lon) };
	})
		.filter((s) => s.distanceM <= 400)
		.sort((a, b) => a.distanceM - b.distanceM);

function seg(
	partial: Partial<EnrichedSegment> & { startTs: number; endTs: number; mode: EnrichedSegment["mode"] },
): EnrichedSegment {
	return {
		confidence: 0.9,
		confidenceMargin: 5,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 10,
		...partial,
	};
}

/** Stationary fixes clustered at a station. */
function fixesAt(station: { north: number; east: number }, fromTs: number, toTs: number): FilteredPoint[] {
	const out: FilteredPoint[] = [];
	for (let ts = fromTs; ts < toTs; ts += 60) {
		out.push({ ...at(station.north, station.east), ts, speed_kmh: 0, bearing: 0 });
	}
	return out;
}

describe("absorbBoardingPlatform", () => {
	it("absorbs a short stationary at the boarding station into the train", async () => {
		const segments = [
			seg({ startTs: 1000, endTs: 1300, mode: "walking" }),
			seg({ startTs: 1300, endTs: 1600, mode: "stationary", place: "Somewhere" }),
			seg({ startTs: 1600, endTs: 2200, mode: "train", wayName: "Alpha → Beta · Line 1" }),
		];
		const points = fixesAt(STATIONS[0], 1300, 1600); // stationary clusters at Alpha
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);

		expect(result.map((s) => s.mode)).toEqual(["walking", "train"]);
		// The train now starts where the platform wait began.
		expect(result[1].startTs).toBe(1300);
		expect(result[1].endTs).toBe(2200);
		expect(result[1].wayName).toBe("Alpha → Beta · Line 1");
	});

	it("leaves a stationary that resolves to a different station", async () => {
		const segments = [
			seg({ startTs: 1000, endTs: 1300, mode: "walking" }),
			seg({ startTs: 1300, endTs: 1600, mode: "stationary" }),
			seg({ startTs: 1600, endTs: 2200, mode: "train", wayName: "Alpha → Beta · Line 1" }),
		];
		// Stationary sits at Beta, but the train boards at Alpha.
		const points = fixesAt(STATIONS[1], 1300, 1600);
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);
		expect(result).toHaveLength(3);
		expect(result[1].mode).toBe("stationary");
	});

	it("leaves a long stay even at the boarding station", async () => {
		const segments = [
			seg({ startTs: 1000, endTs: 1300, mode: "walking" }),
			seg({ startTs: 1300, endTs: 2500, mode: "stationary" }), // 20 min
			seg({ startTs: 2500, endTs: 3100, mode: "train", wayName: "Alpha → Beta" }),
		];
		const points = fixesAt(STATIONS[0], 1300, 2500);
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);
		expect(result).toHaveLength(3);
		expect(result[1].mode).toBe("stationary");
	});

	it("does nothing when the train has no station-pair wayName", async () => {
		const segments = [
			seg({ startTs: 1300, endTs: 1600, mode: "stationary" }),
			seg({ startTs: 1600, endTs: 2200, mode: "train", wayName: "on subway" }),
		];
		const points = fixesAt(STATIONS[0], 1300, 1600);
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);
		expect(result).toHaveLength(2);
		expect(result[0].mode).toBe("stationary");
	});

	it("does not absorb a walking segment before the train", async () => {
		const segments = [
			seg({ startTs: 1300, endTs: 1600, mode: "walking" }),
			seg({ startTs: 1600, endTs: 2200, mode: "train", wayName: "Alpha → Beta" }),
		];
		const points = fixesAt(STATIONS[0], 1300, 1600);
		const result = await absorbBoardingPlatform(segments, points, stationsLookup);
		expect(result).toHaveLength(2);
		expect(result[0].mode).toBe("walking");
	});
});
