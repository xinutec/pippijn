/**
 * Tests for the DayState bottom layer.
 *
 * Per the three-altitude design (state / attribute / overlay):
 *
 *   - State: what the person is doing in one non-overlapping interval.
 *     Mode is mutually exclusive at any moment; "sleeping" is one mode.
 *   - Attribute: a qualifier on the current state (asleep=true on a
 *     train-mode state means sleeping-while-in-transit).
 *   - Overlay: spans that enclose many states (city, journey,
 *     day-part). Not in scope here — separate layer.
 *
 * The converter takes the EnrichedSegment[] from velocity.ts plus
 * sleep windows, and produces DayState[]. Rules:
 *
 *   - Sleep window fully inside a stationary-at-X segment, where X
 *     is the user's sleep-place: the stationary mode is rewritten
 *     to "sleeping" for the overlap; the segment splits at sleep
 *     boundaries.
 *   - Sleep window overlaps a moving segment: state keeps the
 *     motion mode; an `asleep: true` attribute is set on the
 *     overlapping portion.
 *   - Adjacent same-state runs merge.
 *   - Non-overlapping. One body, one state at a time.
 */

import { describe, expect, it } from "vitest";
import { segmentsToDayStates, type SleepWindow } from "../../src/sleep/day-state.js";
import type { EnrichedSegment } from "../../src/geo/velocity.js";

function stationary(startTs: number, endTs: number, place: string): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 1,
		confidenceMargin: Number.POSITIVE_INFINITY,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 10,
		place,
	};
}

function walking(startTs: number, endTs: number): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "walking",
		confidence: 0.8,
		confidenceMargin: 4,
		avgSpeed: 5,
		maxSpeed: 6,
		linearity: 0.6,
		pointCount: 5,
	};
}

function train(startTs: number, endTs: number, route: string): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "train",
		refinedMode: "train",
		confidence: 0.9,
		confidenceMargin: Number.POSITIVE_INFINITY,
		avgSpeed: 70,
		maxSpeed: 100,
		linearity: 0.95,
		pointCount: 20,
		wayName: route,
	};
}

describe("segmentsToDayStates — base cases", () => {
	it("converts a single segment into one DayState", () => {
		const segs = [stationary(1000, 2000, "Home")];
		const states = segmentsToDayStates(segs, []);
		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({
			startTs: 1000,
			endTs: 2000,
			mode: "stationary",
			place: "Home",
		});
	});

	it("preserves wayName on moving segments", () => {
		const segs = [train(1000, 2000, "Wembley Park → Kings Cross")];
		const states = segmentsToDayStates(segs, []);
		expect(states[0].mode).toBe("train");
		expect(states[0].wayName).toBe("Wembley Park → Kings Cross");
	});

	it("merges adjacent same-mode same-place segments", () => {
		const segs = [stationary(1000, 1500, "Home"), stationary(1500, 2000, "Home")];
		const states = segmentsToDayStates(segs, []);
		expect(states).toHaveLength(1);
		expect(states[0].startTs).toBe(1000);
		expect(states[0].endTs).toBe(2000);
	});

	it("does not merge adjacent same-mode different-place segments", () => {
		const segs = [stationary(1000, 1500, "Home"), stationary(1500, 2000, "Work")];
		const states = segmentsToDayStates(segs, []);
		expect(states).toHaveLength(2);
	});
});

describe("segmentsToDayStates — sleep-as-mode (sleep at home)", () => {
	const sleepAtHome: SleepWindow = {
		startTs: 100,
		endTs: 1500,
		place: "Home",
		minutesAsleep: 23,
		tz: "Europe/London",
	};

	it("rewrites a stationary-at-Home segment fully inside the sleep window to sleeping", () => {
		// Stationary @ Home from 0 to 2000; sleep is 100-1500. The
		// segment splits into pre-sleep (boring), sleeping (the
		// sleep window), and post-wake stationary.
		const segs = [stationary(0, 2000, "Home")];
		const states = segmentsToDayStates(segs, [sleepAtHome]);
		expect(states.map((s) => ({ start: s.startTs, end: s.endTs, mode: s.mode }))).toEqual([
			{ start: 0, end: 100, mode: "stationary" },
			{ start: 100, end: 1500, mode: "sleeping" },
			{ start: 1500, end: 2000, mode: "stationary" },
		]);
	});

	it("merges adjacent sleeping states from multiple short stationary segments", () => {
		// Two stationary-at-Home segments separated only by the sleep
		// window: after rewriting, they coalesce into one sleeping run
		// (assuming the rewrites are adjacent).
		const segs = [stationary(0, 500, "Home"), stationary(500, 1000, "Home"), stationary(1000, 2000, "Home")];
		const states = segmentsToDayStates(segs, [{ ...sleepAtHome, startTs: 0, endTs: 1500 }]);
		// All three originals merged: sleep window covers most; the
		// post-wake remainder is one stationary block.
		expect(states.map((s) => s.mode)).toEqual(["sleeping", "stationary"]);
		expect(states[0]).toMatchObject({ startTs: 0, endTs: 1500, mode: "sleeping", place: "Home" });
		expect(states[1]).toMatchObject({ startTs: 1500, endTs: 2000, mode: "stationary", place: "Home" });
	});

	it("does NOT rewrite a stationary segment at a different place", () => {
		// Sleep place is Home but the segment overlapping the sleep
		// window is at Work — the user fell asleep at the desk
		// briefly. Don't rewrite the Work segment to sleeping; the
		// sleep window applies to a different place.
		const segs = [stationary(0, 2000, "Work")];
		const states = segmentsToDayStates(segs, [sleepAtHome]);
		// Work stationary stays as stationary throughout — no rewrite.
		expect(states).toHaveLength(1);
		expect(states[0].mode).toBe("stationary");
		expect(states[0].place).toBe("Work");
	});
});

describe("segmentsToDayStates — sleep-as-attribute (sleep while moving)", () => {
	it("sets asleep=true on a train segment fully inside the sleep window", () => {
		// Sleeping on an overnight train. State keeps mode=train; the
		// attribute records the sleep.
		const segs = [train(1000, 2000, "Night Train")];
		const sleepOnTrain: SleepWindow = {
			startTs: 1000,
			endTs: 2000,
			place: null,
			minutesAsleep: 16,
			tz: "Europe/London",
		};
		const states = segmentsToDayStates(segs, [sleepOnTrain]);
		expect(states).toHaveLength(1);
		expect(states[0].mode).toBe("train");
		expect(states[0].asleep).toBe(true);
	});

	it("splits a moving segment that overlaps the sleep window partially", () => {
		// Train 1000-2000; sleep 1500-2500. The first half of the
		// train is awake, the second half is asleep.
		const segs = [train(1000, 2000, "Some Line")];
		const sleepLate: SleepWindow = {
			startTs: 1500,
			endTs: 2500,
			place: null,
			minutesAsleep: 16,
			tz: "Europe/London",
		};
		const states = segmentsToDayStates(segs, [sleepLate]);
		expect(states).toHaveLength(2);
		expect(states[0].startTs).toBe(1000);
		expect(states[0].endTs).toBe(1500);
		expect(states[0].mode).toBe("train");
		expect(states[0].asleep).toBeUndefined();
		expect(states[1].startTs).toBe(1500);
		expect(states[1].endTs).toBe(2000);
		expect(states[1].mode).toBe("train");
		expect(states[1].asleep).toBe(true);
	});
});

describe("segmentsToDayStates — non-overlapping invariant", () => {
	it("output states never overlap in time", () => {
		const segs = [stationary(0, 2000, "Home"), walking(2000, 2500), train(2500, 3500, "Line A")];
		const sleep: SleepWindow = {
			startTs: 100,
			endTs: 1500,
			place: "Home",
			minutesAsleep: 23,
			tz: "Europe/London",
		};
		const states = segmentsToDayStates(segs, [sleep]);
		for (let i = 1; i < states.length; i++) {
			expect(states[i].startTs).toBeGreaterThanOrEqual(states[i - 1].endTs);
		}
	});
});
