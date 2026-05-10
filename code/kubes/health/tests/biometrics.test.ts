import { describe, expect, it } from "vitest";
import {
	type BiometricEnrichment,
	cadenceForSegment,
	correctModeFromCadence,
	enrichSegmentWithBiometrics,
	type HrPoint,
	type SleepStageRecord,
	type StepPoint,
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

describe("enrichSegmentWithBiometrics — step counts", () => {
	const step = (ts: number, steps: number): StepPoint => ({ ts, steps });

	it("returns null stepsTotal when no step rows are provided (e.g. Fitbit absent)", () => {
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [], [], []);
		expect(r.stepsTotal).toBeNull();
	});

	it("sums steps inside the segment window", () => {
		// 5 minutes, 100 steps each — 500 total inside the segment.
		const stepPoints: StepPoint[] = Array.from({ length: 5 }, (_, i) => step(i * 60, 100));
		const r = enrichSegmentWithBiometrics(seg(0, 5 * 60), [], [], stepPoints);
		expect(r.stepsTotal).toBe(500);
	});

	it("ignores step rows outside the segment window", () => {
		const stepPoints: StepPoint[] = [
			step(0, 50), // inside
			step(5 * HOUR, 1000), // outside (5h later)
		];
		const r = enrichSegmentWithBiometrics(seg(0, HOUR), [], [], stepPoints);
		expect(r.stepsTotal).toBe(50);
	});

	it("treats zero overlap with same-day step rows as Fitbit-on, zero steps", () => {
		// User wore the Fitbit (we have step rows for the day) but the
		// segment in question saw no movement — distinguish from "no Fitbit".
		const stepPoints: StepPoint[] = [step(7 * HOUR, 200)]; // morning steps
		// Segment is later and quiet:
		const r = enrichSegmentWithBiometrics(seg(10 * HOUR, 11 * HOUR), [], [], stepPoints);
		expect(r.stepsTotal).toBe(0);
	});

	it("walking segment with steady cadence: ~80 steps/min for 10 min = 800", () => {
		const start = 0;
		const end = 10 * 60;
		const stepPoints: StepPoint[] = Array.from({ length: 10 }, (_, i) => step(i * 60, 80));
		const r = enrichSegmentWithBiometrics(seg(start, end), [], [], stepPoints);
		expect(r.stepsTotal).toBe(800);
	});
});

describe("cadenceForSegment", () => {
	const step = (ts: number, steps: number): StepPoint => ({ ts, steps });

	it("returns 0 for an empty step array", () => {
		expect(cadenceForSegment(seg(0, HOUR), [])).toBe(0);
	});

	it("returns steps-per-minute over the segment duration", () => {
		// 10 minutes, 80 steps each minute → 800 / 10 = 80 steps/min
		const points = Array.from({ length: 10 }, (_, i) => step(i * 60, 80));
		expect(cadenceForSegment(seg(0, 10 * 60), points)).toBeCloseTo(80, 0);
	});

	it("ignores step rows outside the segment", () => {
		const points = [step(0, 100), step(7 * HOUR, 200)];
		// Segment 1m → 100 steps total, 100 steps/min
		expect(cadenceForSegment(seg(0, 60), points)).toBeCloseTo(100, 0);
	});

	it("returns 0 for very short segments (no minutes to average over)", () => {
		// segment <30s — denominator would be tiny and we'd amplify any noise
		const points = [step(0, 5)];
		expect(cadenceForSegment(seg(0, 20), points)).toBe(0);
	});
});

describe("correctModeFromCadence — passenger-in-traffic detection", () => {
	const step = (ts: number, steps: number): StepPoint => ({ ts, steps });
	type SegLike = TrackSegment & { refinedMode?: string; refinedReason?: string };
	const baseSeg = (mode: "walking" | "driving" | "stationary", avgSpeed: number, durationS: number): SegLike => ({
		startTs: 0,
		endTs: durationS,
		mode,
		confidence: 1,
		avgSpeed,
		maxSpeed: avgSpeed * 1.2,
		linearity: 0.5,
		pointCount: 5,
	});

	it("re-labels walking → driving when cadence is near zero (passenger in slow traffic)", () => {
		// 4 km/h "walking" with no steps for 5 minutes → not actually walking.
		const seg = baseSeg("walking", 4, 5 * 60);
		const r = correctModeFromCadence(seg, []); // no step rows → fall through to "no Fitbit"
		// With no data, must NOT correct (no cadence info to act on).
		expect(r.refinedMode ?? r.mode).toBe("walking");
	});

	it("re-labels walking → driving when cadence is near zero AND Fitbit data exists", () => {
		// Fitbit was on (some step rows for the day) but the walking segment
		// itself has no steps → user was a passenger.
		const seg = baseSeg("walking", 4, 5 * 60);
		// Other-segment step row in the same day to signal "Fitbit on".
		const stepsThisDay: StepPoint[] = [step(7 * HOUR, 100)];
		const r = correctModeFromCadence(seg, stepsThisDay);
		expect(r.refinedMode).toBe("driving");
		expect(r.refinedReason).toMatch(/cadence/i);
	});

	it("keeps walking when cadence is in the walking range (80–120/min)", () => {
		const seg = baseSeg("walking", 4, 5 * 60);
		// 90 steps/min × 5 min = 450 steps in segment
		const stepsThisDay: StepPoint[] = Array.from({ length: 5 }, (_, i) => step(i * 60, 90));
		const r = correctModeFromCadence(seg, stepsThisDay);
		expect(r.refinedMode ?? r.mode).toBe("walking");
	});

	it("keeps walking for slow / interrupted urban walking (~25–40 steps/min)", () => {
		// Regression: a real urban walk with frequent stops (window-shopping,
		// crossings, queues) reads ~27 steps/min over 10 min = 270 steps.
		// Must not be falsely corrected to driving — better to under-correct
		// than to corrupt a real walking segment.
		const seg = baseSeg("walking", 3, 10 * 60);
		const stepsThisDay: StepPoint[] = Array.from({ length: 10 }, (_, i) => step(i * 60, 27));
		const r = correctModeFromCadence(seg, stepsThisDay);
		expect(r.refinedMode ?? r.mode).toBe("walking");
	});

	it("does NOT correct very short segments (insufficient cadence sample)", () => {
		// 1-min walking with no steps could be a brief pause; don'\''t over-react.
		const seg = baseSeg("walking", 4, 60);
		const stepsThisDay: StepPoint[] = [step(7 * HOUR, 100)];
		const r = correctModeFromCadence(seg, stepsThisDay);
		expect(r.refinedMode ?? r.mode).toBe("walking");
	});

	it("does NOT correct walking at high speed (already implausible as walking)", () => {
		// If avgSpeed > 15 km/h, the segment classifier would already prefer
		// cycling/driving — cadence correction shouldn'\''t override.
		const seg = baseSeg("walking", 25, 5 * 60);
		const r = correctModeFromCadence(seg, [step(7 * HOUR, 100)]);
		expect(r.refinedMode ?? r.mode).toBe("walking"); // unchanged
	});

	it("leaves driving / stationary segments alone (this pass only fixes walking)", () => {
		const driving = baseSeg("driving", 50, 5 * 60);
		const stationary = baseSeg("stationary", 0, 5 * 60);
		expect(correctModeFromCadence(driving, []).refinedMode ?? "driving").toBe("driving");
		expect(correctModeFromCadence(stationary, []).refinedMode ?? "stationary").toBe("stationary");
	});

	it("preserves an existing refinedReason in the corrected segment", () => {
		const seg = { ...baseSeg("walking", 4, 5 * 60), refinedReason: "near tertiary" };
		const r = correctModeFromCadence(seg, [step(7 * HOUR, 100)]);
		expect(r.refinedMode).toBe("driving");
		expect(r.refinedReason).toMatch(/near tertiary/);
		expect(r.refinedReason).toMatch(/cadence/i);
	});
});
