import { describe, expect, it } from "vitest";
import {
	type Cluster,
	classifyCluster,
	clusterStays,
	detectFocusPlaces,
	detectStays,
	localSolarDayOfWeek,
	localSolarHour,
	type RawPoint,
	type Stay,
	uniqueDayCount,
} from "../src/geo/focus-places.js";

// Helpers
function offset(lat: number, lon: number, north: number, east: number): { lat: number; lon: number } {
	const dLat = north / 111320;
	const dLon = east / (111320 * Math.cos((lat * Math.PI) / 180));
	return { lat: lat + dLat, lon: lon + dLon };
}

const HOME_LAT = 51.56997;
const HOME_LON = -0.27896;

function point(ts: number, lat: number, lon: number, accuracy: number | null = 20): RawPoint {
	return { ts, lat, lon, accuracy };
}

// ts builder: days/hours/minutes since 2026-02-09 00:00 UTC
const BASE_TS = Math.floor(Date.UTC(2026, 1, 9) / 1000);
function at(daysFromBase: number, hour = 0, minute = 0): number {
	return BASE_TS + daysFromBase * 86400 + hour * 3600 + minute * 60;
}

// Synthetic stay: emit one fix every `intervalMin` for `durationMin` minutes
// at a tight cluster around (lat, lon).
function stayPoints(startTs: number, durationMin: number, intervalMin: number, lat: number, lon: number): RawPoint[] {
	const out: RawPoint[] = [];
	const intervalSec = intervalMin * 60;
	const endTs = startTs + durationMin * 60;
	for (let t = startTs; t <= endTs; t += intervalSec) {
		// jitter by ~5m
		const j = offset(lat, lon, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
		out.push(point(t, j.lat, j.lon, 15));
	}
	return out;
}

describe("detectStays", () => {
	it("returns nothing for empty input", () => {
		expect(detectStays([])).toEqual([]);
	});

	it("emits one stay for points clustered tightly for ≥ 10 min", () => {
		const pts = stayPoints(at(0, 9), 60, 5, HOME_LAT, HOME_LON);
		const stays = detectStays(pts);
		expect(stays).toHaveLength(1);
		expect(stays[0].pointCount).toBeGreaterThan(2);
		expect(stays[0].durationSec).toBeGreaterThanOrEqual(600);
		// Centroid should be very close to the seed location
		expect(Math.abs(stays[0].centroidLat - HOME_LAT)).toBeLessThan(0.0001);
	});

	it("does NOT emit a stay if the window is shorter than 10 min", () => {
		const pts = stayPoints(at(0, 9), 5, 1, HOME_LAT, HOME_LON);
		expect(detectStays(pts)).toHaveLength(0);
	});

	it("breaks the window when the user moves elsewhere", () => {
		// 30 min at home, then 30 min ~5km away at work
		const home = stayPoints(at(0, 9), 30, 5, HOME_LAT, HOME_LON);
		const work = stayPoints(at(0, 10), 30, 5, HOME_LAT + 0.05, HOME_LON);
		const stays = detectStays([...home, ...work]);
		expect(stays).toHaveLength(2);
		expect(stays[0].centroidLat).toBeCloseTo(HOME_LAT, 3);
		expect(stays[1].centroidLat).toBeCloseTo(HOME_LAT + 0.05, 3);
	});

	it("treats overnight phone-silence as a continuous stay (no max-gap rule)", () => {
		// One fix at 23:00, next at 07:00 next day, both at home
		const last = point(at(0, 23), HOME_LAT, HOME_LON, 20);
		const first = point(at(1, 7), HOME_LAT + 0.00001, HOME_LON + 0.00001, 20);
		const stays = detectStays([last, first]);
		expect(stays).toHaveLength(1);
		expect(stays[0].durationSec).toBe(8 * 3600);
	});
});

describe("clusterStays", () => {
	it("merges two distinct stays at the same place into one cluster", () => {
		// Test clusterStays directly — two synthetic stays at the same coords
		// (detectStays would merge them because of the no-gap rule).
		const stays: Stay[] = [stay(0, 12, HOME_LAT, HOME_LON), stay(7, 12, HOME_LAT, HOME_LON)];
		const clusters = clusterStays(stays);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].stays).toHaveLength(2);
	});

	it("keeps distinct clusters for places > 200m apart", () => {
		// HOME and 500m east
		const home = stayPoints(at(0, 9), 30, 5, HOME_LAT, HOME_LON);
		const far = offset(HOME_LAT, HOME_LON, 0, 500);
		const elsewhere = stayPoints(at(1, 9), 30, 5, far.lat, far.lon);
		const stays = detectStays([...home, ...elsewhere]);
		const clusters = clusterStays(stays);
		expect(clusters.length).toBeGreaterThanOrEqual(2);
	});

	it("post-merge pass combines clusters that drifted within radius", () => {
		// First three stays are slightly offset from each other so greedy
		// clustering creates one cluster whose centroid moves between them.
		// A fourth stay then ties two of those drifted-apart clusters together.
		// Set up: three stays at lat 0, 0+25m, 0+50m, 0+75m east.
		const stays: Stay[] = [
			stay(0, 9, HOME_LAT, HOME_LON),
			stay(1, 9, ...Object.values(offset(HOME_LAT, HOME_LON, 0, 60))),
			stay(2, 9, ...Object.values(offset(HOME_LAT, HOME_LON, 0, 120))),
			stay(3, 9, ...Object.values(offset(HOME_LAT, HOME_LON, 0, 80))),
		];
		const clusters = clusterStays(stays);
		// All four should land in one cluster after merging
		expect(clusters).toHaveLength(1);
		expect(clusters[0].stays).toHaveLength(4);
	});
});

function stay(day: number, hour: number, lat: number, lon: number): Stay {
	const startTs = at(day, hour);
	return {
		startTs,
		endTs: startTs + 1800, // 30 min
		centroidLat: lat,
		centroidLon: lon,
		pointCount: 6,
		durationSec: 1800,
	};
}

function makeCluster(stays: Stay[]): Cluster {
	const totalDwell = stays.reduce((s, x) => s + x.durationSec, 0);
	let cLat = 0;
	let cLon = 0;
	for (const s of stays) {
		cLat += (s.centroidLat * s.durationSec) / totalDwell;
		cLon += (s.centroidLon * s.durationSec) / totalDwell;
	}
	return { id: 1, centroidLat: cLat, centroidLon: cLon, stays, totalDwellSec: totalDwell };
}

describe("classifyCluster", () => {
	it("labels long-running overnight presence as home", () => {
		// 30 nights over 60 days, 8h/night at HOME
		const stays: Stay[] = [];
		for (let d = 0; d < 60; d += 2) {
			const startTs = at(d, 22); // 22:00
			stays.push({
				startTs,
				endTs: startTs + 8 * 3600,
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 8,
				durationSec: 8 * 3600,
			});
		}
		const cls = classifyCluster(makeCluster(stays));
		expect(cls.label).toBe("home");
	});

	it("labels long-running weekday-daytime presence as work", () => {
		// 20 weekday workdays, 9-17 each, no overnight
		const stays: Stay[] = [];
		for (let d = 0; d < 30; d++) {
			const dow = localSolarDayOfWeek(at(d, 12), HOME_LON);
			if (dow > 4) continue; // skip weekends
			const startTs = at(d, 9);
			stays.push({
				startTs,
				endTs: startTs + 8 * 3600,
				centroidLat: HOME_LAT + 0.01,
				centroidLon: HOME_LON + 0.01,
				pointCount: 8,
				durationSec: 8 * 3600,
			});
		}
		const cls = classifyCluster(makeCluster(stays));
		expect(cls.label).toBe("work");
	});

	it("labels short-window overnight presence as hotel", () => {
		// 5 consecutive nights at one place, no other history
		const stays: Stay[] = [];
		for (let d = 0; d < 5; d++) {
			const startTs = at(d, 22);
			stays.push({
				startTs,
				endTs: startTs + 8 * 3600,
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 8,
				durationSec: 8 * 3600,
			});
		}
		const cls = classifyCluster(makeCluster(stays));
		expect(cls.label).toBe("hotel");
	});

	it("labels a single visit as one-off", () => {
		const cls = classifyCluster(makeCluster([stay(0, 14, HOME_LAT, HOME_LON)]));
		expect(cls.label).toBe("one-off");
	});

	it("labels recurring visits over a wide span as frequent", () => {
		// 8 visits across 60 days, each 1h, daytime
		const stays: Stay[] = [];
		for (let d = 0; d < 60; d += 8) {
			const startTs = at(d, 14);
			stays.push({
				startTs,
				endTs: startTs + 3600,
				centroidLat: HOME_LAT,
				centroidLon: HOME_LON,
				pointCount: 6,
				durationSec: 3600,
			});
		}
		const cls = classifyCluster(makeCluster(stays));
		expect(cls.label).toBe("frequent");
	});
});

describe("uniqueDayCount", () => {
	it("counts distinct local days, not stay count", () => {
		// 4 visits all on the same day
		const stays: Stay[] = [
			stay(0, 9, HOME_LAT, HOME_LON),
			stay(0, 12, HOME_LAT, HOME_LON),
			stay(0, 15, HOME_LAT, HOME_LON),
			stay(0, 18, HOME_LAT, HOME_LON),
		];
		expect(uniqueDayCount(stays, HOME_LON)).toBe(1);
	});
});

describe("localSolarHour", () => {
	it("returns local hour from longitude — California is ~8h behind UTC", () => {
		// UTC noon at lon=-120 (Pacific) → ~04:00 local
		const utcNoon = Date.UTC(2026, 0, 1, 12, 0) / 1000;
		expect(localSolarHour(utcNoon, -120)).toBe(4);
	});

	it("returns local hour from longitude — UK is ~0h offset", () => {
		const utcNoon = Date.UTC(2026, 0, 1, 12, 0) / 1000;
		expect(localSolarHour(utcNoon, 0)).toBe(12);
	});
});

describe("detectFocusPlaces", () => {
	it("filters low-accuracy points before stay detection", () => {
		const good = stayPoints(at(0, 9), 30, 5, HOME_LAT, HOME_LON);
		const bad = good.map((p) => ({ ...p, accuracy: 500 }));
		expect(detectFocusPlaces(good).clusters).toHaveLength(1);
		expect(detectFocusPlaces(bad).clusters).toHaveLength(0);
	});

	it("returns clusters sorted by total dwell, descending", () => {
		// One short stay at A, one long stay at B
		const a = stayPoints(at(0, 9), 15, 5, HOME_LAT, HOME_LON);
		const bLatLon = offset(HOME_LAT, HOME_LON, 1000, 0);
		const b = stayPoints(at(1, 9), 240, 5, bLatLon.lat, bLatLon.lon);
		const result = detectFocusPlaces([...a, ...b]);
		expect(result.clusters.length).toBeGreaterThanOrEqual(2);
		expect(result.clusters[0].totalDwellSec).toBeGreaterThan(result.clusters[1].totalDwellSec);
	});
});
