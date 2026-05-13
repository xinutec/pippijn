/**
 * Tests for sleep loaders — the pure parts that don't need a DB.
 * The DB-touching `loadDaySleepWindows` is verified end-to-end via
 * analyze-day on a real fixture.
 */

import { describe, expect, it } from "vitest";
import { derivePlaceForSleep, nextDateString } from "../../src/sleep/load.js";
import type { EnrichedSegment } from "../../src/geo/velocity.js";

function stationary(startTs: number, endTs: number, place?: string): EnrichedSegment {
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

describe("nextDateString", () => {
	it("rolls forward by one day", () => {
		expect(nextDateString("2026-05-12")).toBe("2026-05-13");
	});

	it("handles month boundaries", () => {
		expect(nextDateString("2026-05-31")).toBe("2026-06-01");
	});

	it("handles year boundaries", () => {
		expect(nextDateString("2026-12-31")).toBe("2027-01-01");
	});

	it("handles leap-year February", () => {
		expect(nextDateString("2024-02-28")).toBe("2024-02-29");
		expect(nextDateString("2024-02-29")).toBe("2024-03-01");
	});

	it("handles non-leap-year February", () => {
		expect(nextDateString("2025-02-28")).toBe("2025-03-01");
	});
});

describe("derivePlaceForSleep", () => {
	it("finds the place of a stationary segment containing the sleep start", () => {
		const segs = [stationary(0, 1000, "Home"), stationary(1000, 2000, "Work")];
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("returns null when the sleep start falls inside a moving segment", () => {
		const segs: EnrichedSegment[] = [
			{
				startTs: 0,
				endTs: 1000,
				mode: "train",
				confidence: 0.9,
				confidenceMargin: Number.POSITIVE_INFINITY,
				avgSpeed: 70,
				maxSpeed: 100,
				linearity: 0.95,
				pointCount: 20,
			},
		];
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});

	it("returns null when no stationary segment contains the sleep start", () => {
		const segs = [stationary(0, 100, "Home")]; // ends before sleep starts
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});

	it("returns null when the containing segment has no place tag", () => {
		const segs = [stationary(0, 1000)]; // no place
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});
});
