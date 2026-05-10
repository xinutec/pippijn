import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { classifySegments, type TrackSegment } from "../src/geo/segments.js";

// Helper: generate points moving in a straight line at constant speed
function generateTrack(opts: {
	startTs: number;
	durationSec: number;
	intervalSec: number;
	speedKmh: number;
	bearingDeg?: number;
	startLat?: number;
	startLon?: number;
	speedJitter?: number; // random speed variation in km/h
	bearingJitter?: number; // random bearing variation in degrees
}): FilteredPoint[] {
	const {
		startTs,
		durationSec,
		intervalSec,
		speedKmh,
		bearingDeg = 90,
		startLat = 52.0,
		startLon = 5.0,
		speedJitter = 0,
		bearingJitter = 0,
	} = opts;

	const points: FilteredPoint[] = [];
	const speedMs = speedKmh / 3.6;
	const bearingRad = (bearingDeg * Math.PI) / 180;

	let lat = startLat;
	let lon = startLon;

	for (let t = 0; t <= durationSec; t += intervalSec) {
		const jitteredSpeed = speedKmh + (Math.random() - 0.5) * 2 * speedJitter;
		const jitteredBearing = bearingDeg + (Math.random() - 0.5) * 2 * bearingJitter;

		points.push({
			ts: startTs + t,
			lat,
			lon,
			speed_kmh: Math.max(0, Math.round(jitteredSpeed * 10) / 10),
			bearing: ((jitteredBearing % 360) + 360) % 360,
		});

		// Move forward
		const dlat = (speedMs * intervalSec * Math.cos(bearingRad)) / 6371000 / (Math.PI / 180);
		const dlon =
			(speedMs * intervalSec * Math.sin(bearingRad)) / (6371000 * Math.cos((lat * Math.PI) / 180)) / (Math.PI / 180);
		lat += dlat;
		lon += dlon;
	}

	return points;
}

// Helper: generate a meandering walking track
function generateWalk(startTs: number, durationSec: number): FilteredPoint[] {
	const points: FilteredPoint[] = [];
	let lat = 52.0;
	let lon = 5.0;
	let bearing = 0;

	for (let t = 0; t <= durationSec; t += 15) {
		const speed = 3 + Math.random() * 3; // 3-6 km/h
		bearing += (Math.random() - 0.5) * 60; // wander ±30 degrees

		const speedMs = speed / 3.6;
		const bearingRad = (bearing * Math.PI) / 180;
		lat += (speedMs * 15 * Math.cos(bearingRad)) / 6371000 / (Math.PI / 180);
		lon += (speedMs * 15 * Math.sin(bearingRad)) / (6371000 * Math.cos((lat * Math.PI) / 180)) / (Math.PI / 180);

		points.push({
			ts: startTs + t,
			lat,
			lon,
			speed_kmh: Math.round(speed * 10) / 10,
			bearing: ((bearing % 360) + 360) % 360,
		});
	}

	return points;
}

function findSegment(segments: TrackSegment[], mode: string): TrackSegment | undefined {
	return segments.find((s) => s.mode === mode);
}

describe("classifySegments", () => {
	it("returns empty for empty input", () => {
		expect(classifySegments([])).toEqual([]);
	});

	it("classifies stationary points", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 30,
			speedKmh: 0.5,
			speedJitter: 0.3,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		expect(segments[0].mode).toBe("stationary");
	});

	it("classifies walking", () => {
		const points = generateWalk(1000, 600);
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const walk = findSegment(segments, "walking");
		expect(walk).toBeDefined();
	});

	it("classifies cycling", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 15,
			speedKmh: 20,
			speedJitter: 3,
			bearingJitter: 5,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const cycling = findSegment(segments, "cycling");
		expect(cycling).toBeDefined();
	});

	it("classifies train (high speed, very linear, consistent)", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 15,
			speedKmh: 140,
			speedJitter: 3,
			bearingJitter: 0.5,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const train = findSegment(segments, "train");
		expect(train).toBeDefined();
		if (train) {
			expect(train.linearity).toBeGreaterThan(0.9);
		}
	});

	it("classifies driving (moderate speed, some acceleration)", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 10,
			speedKmh: 60,
			speedJitter: 15,
			bearingJitter: 3,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const driving = findSegment(segments, "driving");
		expect(driving).toBeDefined();
	});

	it("classifies plane (very high speed, extremely linear)", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 600,
			intervalSec: 30,
			speedKmh: 500,
			speedJitter: 10,
			bearingJitter: 0.2,
		});
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		const plane = findSegment(segments, "plane");
		expect(plane).toBeDefined();
	});

	it("detects transition from walking to train", () => {
		// 10 min walking then 10 min train
		const walk = generateWalk(1000, 600);
		const train = generateTrack({
			startTs: 1600,
			durationSec: 600,
			intervalSec: 15,
			speedKmh: 130,
			speedJitter: 3,
			bearingJitter: 0.5,
			startLat: walk[walk.length - 1].lat,
			startLon: walk[walk.length - 1].lon,
		});
		const points = [...walk, ...train];
		const segments = classifySegments(points);

		expect(segments.length).toBeGreaterThanOrEqual(2);
		// Should have both walking and train/driving segments
		const modes = segments.map((s) => s.mode);
		const hasSlowMode = modes.some((m) => m === "walking" || m === "stationary");
		const hasFastMode = modes.some((m) => m === "train" || m === "driving");
		expect(hasSlowMode).toBe(true);
		expect(hasFastMode).toBe(true);
	});

	it("merges short segments into neighbors", () => {
		// Long walk, 30s stationary, long walk — the stationary blip should merge
		const walk1 = generateWalk(1000, 600);
		const lastPoint = walk1[walk1.length - 1];
		const pause: FilteredPoint[] = [
			{ ts: 1600, lat: lastPoint.lat, lon: lastPoint.lon, speed_kmh: 0, bearing: 0 },
			{ ts: 1630, lat: lastPoint.lat, lon: lastPoint.lon, speed_kmh: 0, bearing: 0 },
		];
		const walk2 = generateWalk(1630, 600);
		const points = [...walk1, ...pause, ...walk2];
		const segments = classifySegments(points);

		// The short pause shouldn't create its own segment (< 2 min threshold)
		const stationarySegments = segments.filter((s) => s.mode === "stationary" && s.endTs - s.startTs < 120);
		expect(stationarySegments).toHaveLength(0);
	});

	it("segments have valid timestamps", () => {
		const points = generateWalk(1000, 1200);
		const segments = classifySegments(points);

		for (const seg of segments) {
			expect(seg.startTs).toBeLessThanOrEqual(seg.endTs);
			expect(seg.pointCount).toBeGreaterThan(0);
			expect(seg.confidence).toBeGreaterThanOrEqual(0);
			expect(seg.avgSpeed).toBeGreaterThanOrEqual(0);
			expect(seg.linearity).toBeGreaterThanOrEqual(0);
			expect(seg.linearity).toBeLessThanOrEqual(1);
		}
	});

	it("classifies fidgeting in one spot as stationary, not walking", () => {
		// Simulates throwing stones at a river: small movements (1-3 km/h GPS noise)
		// but all within a ~20m radius for 35 minutes
		const points: FilteredPoint[] = [];
		const centerLat = 51.8454;
		const centerLon = 5.8633;
		for (let t = 0; t <= 2100; t += 30) {
			// Random jitter within ~15m
			const jitterLat = (Math.random() - 0.5) * 0.0003;
			const jitterLon = (Math.random() - 0.5) * 0.0003;
			points.push({
				ts: 1000 + t,
				lat: centerLat + jitterLat,
				lon: centerLon + jitterLon,
				speed_kmh: Math.random() * 3, // 0-3 km/h GPS noise
				bearing: Math.random() * 360,
			});
		}
		const segments = classifySegments(points);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		// Should be classified as stationary, NOT walking
		const primary = segments.reduce((a, b) => (b.endTs - b.startTs > a.endTs - a.startTs ? b : a));
		expect(primary.mode).toBe("stationary");
	});

	it("emits a stay segment from sparse points after a moving segment", () => {
		// 10 minutes walking, then 30 minutes of sparse points clustered tightly
		// (simulating phone going indoors with poor GPS) — the classifier's window
		// pass would silently drop the indoor period; findStays should fill it.
		const walk = generateWalk(1000, 600);
		const last = walk[walk.length - 1];
		const stay: FilteredPoint[] = [];
		// Sparse: only 6 points across 30 minutes, all within ~30m of last walk point
		for (let t = 0; t < 6; t++) {
			stay.push({
				ts: 1700 + t * 300, // every 5 min
				lat: last.lat + (Math.random() - 0.5) * 0.0004,
				lon: last.lon + (Math.random() - 0.5) * 0.0004,
				speed_kmh: 0,
				bearing: 0,
			});
		}
		const segments = classifySegments([...walk, ...stay]);
		const stationary = segments.find((s) => s.mode === "stationary" && s.startTs >= 1700);
		expect(stationary).toBeDefined();
		if (stationary) {
			expect(stationary.endTs - stationary.startTs).toBeGreaterThanOrEqual(15 * 60);
		}
	});

	it("does not emit a stay when sparse points span > 100m", () => {
		// Same shape as above but the points wander 300m apart — not a stay
		const walk = generateWalk(1000, 600);
		const last = walk[walk.length - 1];
		const wander: FilteredPoint[] = [];
		for (let t = 0; t < 6; t++) {
			wander.push({
				ts: 1700 + t * 300,
				lat: last.lat + t * 0.001, // ~111m per step
				lon: last.lon,
				speed_kmh: 0,
				bearing: 0,
			});
		}
		const segments = classifySegments([...walk, ...wander]);
		const lateStationary = segments.find((s) => s.mode === "stationary" && s.startTs >= 1700);
		expect(lateStationary).toBeUndefined();
	});

	it("does not emit a stay when sparse cluster duration < 15 min", () => {
		const walk = generateWalk(1000, 600);
		const last = walk[walk.length - 1];
		const tooShort: FilteredPoint[] = [];
		for (let t = 0; t < 3; t++) {
			tooShort.push({
				ts: 1700 + t * 200, // 0, 200, 400 seconds = 6.7 min total
				lat: last.lat,
				lon: last.lon,
				speed_kmh: 0,
				bearing: 0,
			});
		}
		const segments = classifySegments([...walk, ...tooShort]);
		const lateStationary = segments.find((s) => s.mode === "stationary" && s.startTs >= 1700);
		expect(lateStationary).toBeUndefined();
	});

	it("emits a stay even when no other segments exist", () => {
		// Phone sat in one place all day, sparse GPS, classifier sees no movement
		const stay: FilteredPoint[] = [];
		for (let t = 0; t < 8; t++) {
			stay.push({
				ts: 1000 + t * 600, // every 10 min for 70 min
				lat: 52.0 + (Math.random() - 0.5) * 0.0003,
				lon: 5.0 + (Math.random() - 0.5) * 0.0003,
				speed_kmh: 0,
				bearing: 0,
			});
		}
		const segments = classifySegments(stay);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		expect(segments[0].mode).toBe("stationary");
	});

	it("segments cover the full track", () => {
		const points = generateTrack({
			startTs: 1000,
			durationSec: 1200,
			intervalSec: 15,
			speedKmh: 50,
		});
		const segments = classifySegments(points);

		if (segments.length > 0) {
			expect(segments[0].startTs).toBe(points[0].ts);
			// Last segment should end within one window of the track end
			const lastSegEnd = segments[segments.length - 1].endTs;
			const trackEnd = points[points.length - 1].ts;
			expect(lastSegEnd).toBeGreaterThanOrEqual(trackEnd - 300);
			expect(lastSegEnd).toBeLessThanOrEqual(trackEnd);
		}
	});
});
