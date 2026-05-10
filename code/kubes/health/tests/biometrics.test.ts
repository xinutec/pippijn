import { describe, expect, it } from "vitest";
import {
	type BiometricEnrichment,
	enrichSegmentWithBiometrics,
	type HrPoint,
	type SleepStageRecord,
} from "../src/geo/biometrics.js";
import type { TrackSegment } from "../src/geo/segments.js";

function seg(startTs: number, endTs: number): TrackSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 1,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 5,
	};
}

function hr(ts: number, bpm: number): HrPoint {
	return { ts, bpm };
}

function sleep(startTs: number, endTs: number, stage = "asleep"): SleepStageRecord {
	return { startTs, endTs, stage };
}

const HOUR = 3600;

describe("enrichSegmentWithBiometrics — missing data fallbacks", () => {
	it("returns nulls and sampleCount=0 when no HR data exists (e.g. Fitbit on charger)", () => {
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [], []);
		expect(r.hrMean).toBeNull();
		expect(r.hrMin).toBeNull();
		expect(r.hrMax).toBeNull();
		expect(r.hrStd).toBeNull();
		expect(r.sampleCount).toBe(0);
		expect(r.overlapsSleep).toBe(false);
		expect(r.sleepFraction).toBe(0);
	});

	it("works with HR but no sleep records (Fitbit recorded HR but no sleep that night)", () => {
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [hr(60, 70), hr(120, 75), hr(180, 72)], []);
		expect(r.hrMean).not.toBeNull();
		expect(r.sampleCount).toBe(3);
		expect(r.overlapsSleep).toBe(false);
	});

	it("works with sleep records but no HR data (Fitbit died mid-day)", () => {
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [], [sleep(0, HOUR / 2)]);
		expect(r.hrMean).toBeNull();
		expect(r.sampleCount).toBe(0);
		expect(r.overlapsSleep).toBe(true);
		expect(r.sleepFraction).toBeCloseTo(0.5, 2);
	});

	it("ignores HR points outside the segment window", () => {
		// Segment 100..200; HR points at 50 (before), 150 (in), 250 (after)
		const r = enrichSegmentWithBiometrics(seg(100, 200), [hr(50, 60), hr(150, 80), hr(250, 90)], []);
		expect(r.sampleCount).toBe(1);
		expect(r.hrMean).toBe(80);
	});
});

describe("enrichSegmentWithBiometrics — HR statistics", () => {
	it("computes mean, min, max, std for HR in window", () => {
		// Constant 80 bpm → mean=80, std=0
		const r1 = enrichSegmentWithBiometrics(seg(0, 100), [hr(10, 80), hr(50, 80), hr(90, 80)], []);
		expect(r1.hrMean).toBe(80);
		expect(r1.hrMin).toBe(80);
		expect(r1.hrMax).toBe(80);
		expect(r1.hrStd).toBe(0);

		// Varying HR → non-zero std
		const r2 = enrichSegmentWithBiometrics(seg(0, 100), [hr(10, 60), hr(50, 80), hr(90, 100)], []);
		expect(r2.hrMean).toBe(80);
		expect(r2.hrMin).toBe(60);
		expect(r2.hrMax).toBe(100);
		expect(r2.hrStd).toBeGreaterThan(0);
	});
});

describe("enrichSegmentWithBiometrics — sleep overlap", () => {
	it("fully covers the segment → sleepFraction=1", () => {
		const r = enrichSegmentWithBiometrics(seg(100, 200), [], [sleep(50, 250)]);
		expect(r.overlapsSleep).toBe(true);
		expect(r.sleepFraction).toBe(1);
	});

	it("partial overlap (segment 100-200, sleep 150-250) → fraction=0.5", () => {
		const r = enrichSegmentWithBiometrics(seg(100, 200), [], [sleep(150, 250)]);
		expect(r.sleepFraction).toBeCloseTo(0.5, 2);
		expect(r.overlapsSleep).toBe(true);
	});

	it("multiple non-contiguous sleep stages sum correctly", () => {
		// Segment 0-1000; two sleep ranges 100-200 and 700-800 → 200/1000 = 0.2
		const r = enrichSegmentWithBiometrics(seg(0, 1000), [], [sleep(100, 200), sleep(700, 800)]);
		expect(r.sleepFraction).toBeCloseTo(0.2, 2);
	});

	it("no overlap when sleep is entirely outside segment", () => {
		const r = enrichSegmentWithBiometrics(seg(100, 200), [], [sleep(0, 50), sleep(300, 400)]);
		expect(r.overlapsSleep).toBe(false);
		expect(r.sleepFraction).toBe(0);
	});

	it("zero-duration segment doesn't divide by zero", () => {
		const r: BiometricEnrichment = enrichSegmentWithBiometrics(seg(100, 100), [], [sleep(100, 200)]);
		expect(r.sleepFraction).toBe(0);
	});
});

describe("enrichSegmentWithBiometrics — combined real-world cases", () => {
	it("overnight stay at home: HR steady ~55, sleep covers 100% of segment", () => {
		// 8 hour overnight stay
		const start = 0;
		const end = 8 * HOUR;
		const hrPoints: HrPoint[] = [];
		for (let t = start; t < end; t += 60) hrPoints.push(hr(t, 55 + Math.round(Math.random() * 4) - 2));
		const r = enrichSegmentWithBiometrics(seg(start, end), hrPoints, [sleep(start, end)]);
		expect(r.hrMean).toBeGreaterThan(50);
		expect(r.hrMean).toBeLessThan(60);
		expect(r.sleepFraction).toBe(1);
	});

	it("driving in a car as passenger: HR steady ~74, no sleep overlap", () => {
		const start = 0;
		const end = HOUR;
		const hrPoints = Array.from({ length: 20 }, (_, i) => hr(i * 180, 74 + (i % 3) - 1));
		const r = enrichSegmentWithBiometrics(seg(start, end), hrPoints, []);
		expect(r.hrMean).toBeCloseTo(74, 0);
		expect(r.overlapsSleep).toBe(false);
	});
});
