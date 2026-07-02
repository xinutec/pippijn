import { describe, expect, it } from "vitest";
import type { BuildingFootprint } from "../src/geo/osm-local.js";
import { buildingCrossingM, pointInRing } from "../src/eval/walk-buildings.js";
import type { LatLon } from "../src/eval/walk-score.js";

/**
 * `buildingCrossingM` — the headline referee metric the off-walkable proxy is
 * blind to. It measures how much of the DRAWN line's length lies inside a
 * building footprint. Yesterday's snapped Wembley line cut a diagonal chord
 * across a building block and still scored well on off-walkable-p90 (a chord on a
 * way centreline is "near a way"); this metric is what makes that defect visible.
 */

// A ~40 m square building near Wembley (metres → degrees at this latitude).
const LAT = 51.563;
const LON = -0.281;
const dLat = (m: number) => m / 111_320;
const dLon = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));

// Square footprint, corners 40 m on a side, centred at (LAT, LON).
const H = 20;
const square: BuildingFootprint = [
	{ lat: LAT - dLat(H), lon: LON - dLon(H) },
	{ lat: LAT - dLat(H), lon: LON + dLon(H) },
	{ lat: LAT + dLat(H), lon: LON + dLon(H) },
	{ lat: LAT + dLat(H), lon: LON - dLon(H) },
];

describe("pointInRing", () => {
	it("is true at the centre, false well outside", () => {
		expect(pointInRing({ lat: LAT, lon: LON }, square)).toBe(true);
		expect(pointInRing({ lat: LAT + dLat(100), lon: LON }, square)).toBe(false);
	});

	it("is false just outside an edge", () => {
		expect(pointInRing({ lat: LAT, lon: LON + dLon(H + 5) }, square)).toBe(false);
	});
});

describe("buildingCrossingM", () => {
	it("is zero for a line that passes beside the building", () => {
		// A line 60 m north of the square, running west→east — never enters it.
		const drawn: LatLon[] = [
			{ lat: LAT + dLat(60), lon: LON - dLon(50) },
			{ lat: LAT + dLat(60), lon: LON + dLon(50) },
		];
		expect(buildingCrossingM(drawn, [square])).toBeLessThan(1);
	});

	it("measures the crossed length for a chord straight through the building", () => {
		// A west→east line through the centre: it is inside for the ~40 m width.
		const drawn: LatLon[] = [
			{ lat: LAT, lon: LON - dLon(50) },
			{ lat: LAT, lon: LON + dLon(50) },
		];
		const crossed = buildingCrossingM(drawn, [square]);
		expect(crossed).toBeGreaterThan(30);
		expect(crossed).toBeLessThan(50);
	});

	it("is zero when there are no buildings", () => {
		const drawn: LatLon[] = [
			{ lat: LAT, lon: LON - dLon(50) },
			{ lat: LAT, lon: LON + dLon(50) },
		];
		expect(buildingCrossingM(drawn, [])).toBe(0);
	});

	it("returns 0 for a degenerate (single-point) line", () => {
		expect(buildingCrossingM([{ lat: LAT, lon: LON }], [square])).toBe(0);
	});
});
