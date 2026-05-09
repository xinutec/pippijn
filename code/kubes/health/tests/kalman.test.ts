import { describe, expect, it } from "vitest";
import { classifyMode, filterGpsTrack, type GpsPoint } from "../src/geo/kalman.js";

describe("filterGpsTrack", () => {
	it("returns empty for empty input", () => {
		expect(filterGpsTrack([])).toEqual([]);
	});

	it("returns single point with zero speed", () => {
		const result = filterGpsTrack([{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 10 }]);
		expect(result).toHaveLength(1);
		expect(result[0].speed_kmh).toBe(0);
	});

	it("calculates speed for two points", () => {
		// Two points ~111m apart (0.001 degrees latitude), 10 seconds apart
		// Expected speed: ~40 km/h
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1010, lat: 52.001, lon: 5.0, accuracy: 5 },
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(2);
		expect(result[1].speed_kmh).toBeGreaterThan(30);
		expect(result[1].speed_kmh).toBeLessThan(50);
	});

	it("smooths out a GPS spike", () => {
		// Moving steadily north, then one point jumps east, then continues north
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1030, lat: 52.0003, lon: 5.0, accuracy: 5 },
			{ ts: 1060, lat: 52.0006, lon: 5.0, accuracy: 5 },
			{ ts: 1090, lat: 52.0009, lon: 5.005, accuracy: 5 }, // spike east
			{ ts: 1120, lat: 52.0012, lon: 5.0, accuracy: 5 },
			{ ts: 1150, lat: 52.0015, lon: 5.0, accuracy: 5 },
		];
		const result = filterGpsTrack(points);

		// The spike point's longitude should be pulled back toward 5.0
		const spikePoint = result[3];
		expect(spikePoint.lon).toBeLessThan(5.005); // smoothed toward the track
		expect(spikePoint.lon).toBeGreaterThan(5.0); // but not completely (filter is gradual)
	});

	it("handles stationary points (should show ~0 speed)", () => {
		const points: GpsPoint[] = [];
		for (let i = 0; i < 10; i++) {
			points.push({
				ts: 1000 + i * 30,
				lat: 52.0 + (Math.random() - 0.5) * 0.00005, // ±5m noise
				lon: 5.0 + (Math.random() - 0.5) * 0.00005,
				accuracy: 10,
			});
		}
		const result = filterGpsTrack(points);
		// After a few points, speed should settle near 0
		const lastFew = result.slice(-3);
		for (const p of lastFew) {
			expect(p.speed_kmh).toBeLessThan(5);
		}
	});

	it("skips duplicate timestamps", () => {
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 }, // duplicate
			{ ts: 1030, lat: 52.001, lon: 5.0, accuracy: 5 },
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(2); // duplicate skipped
	});

	it("resets on gaps > 1 hour", () => {
		const points: GpsPoint[] = [
			{ ts: 1000, lat: 52.0, lon: 5.0, accuracy: 5 },
			{ ts: 1030, lat: 52.001, lon: 5.0, accuracy: 5 },
			{ ts: 5000, lat: 53.0, lon: 6.0, accuracy: 5 }, // 1+ hour gap, different location
		];
		const result = filterGpsTrack(points);
		expect(result).toHaveLength(3);
		// After reset, speed should be 0 (no velocity history)
		expect(result[2].speed_kmh).toBe(0);
	});

	it("produces consistent speed for constant velocity", () => {
		// Simulate walking north at ~5 km/h for 2 minutes
		// 5 km/h = 1.39 m/s ≈ 0.0000125 deg/s latitude
		const points: GpsPoint[] = [];
		const vDegPerSec = 0.0000125;
		for (let i = 0; i < 8; i++) {
			points.push({
				ts: 1000 + i * 15,
				lat: 52.0 + i * 15 * vDegPerSec,
				lon: 5.0,
				accuracy: 5,
			});
		}
		const result = filterGpsTrack(points);
		// After settling, speed should be near 5 km/h
		const settled = result.slice(-3);
		for (const p of settled) {
			expect(p.speed_kmh).toBeGreaterThan(3);
			expect(p.speed_kmh).toBeLessThan(8);
		}
	});
});

describe("classifyMode", () => {
	it("classifies stationary", () => expect(classifyMode(0)).toBe("stationary"));
	it("classifies walking", () => expect(classifyMode(5)).toBe("walking"));
	it("classifies cycling", () => expect(classifyMode(20)).toBe("cycling"));
	it("classifies driving", () => expect(classifyMode(80)).toBe("driving"));
	it("classifies transit", () => expect(classifyMode(200)).toBe("transit"));
});
