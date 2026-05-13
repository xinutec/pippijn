/**
 * Tests for sleep loaders — the pure parts that don't need a DB.
 * The DB-touching `loadDaySleepWindows` is verified end-to-end via
 * analyze-day on a real fixture.
 */

import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../../src/geo/velocity.js";
import { derivePlaceForSleep, nextDateString } from "../../src/sleep/load.js";

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
	it("finds the place of a stationary segment overlapping the sleep window", () => {
		const segs = [stationary(0, 1000, "Home"), stationary(1000, 2000, "Work")];
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("handles morning sleep: window starts before any segment but wake-up overlaps", () => {
		// Real case: today's "morning sleep" event has startTs the
		// previous evening. The first stationary segment in today's
		// data covers the wake-up endpoint of the sleep window.
		const segs = [stationary(800, 2000, "Home")];
		const window = { startTs: 100, endTs: 1500 }; // starts before segment, ends inside it
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("handles evening sleep: window starts inside a segment, ends after it", () => {
		const segs = [stationary(0, 1500, "Home")];
		const window = { startTs: 1000, endTs: 3000 }; // starts inside, ends after the segment
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("returns null when sleep is entirely inside moving segments (overnight train)", () => {
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

	it("returns null when no stationary segment overlaps the sleep window", () => {
		const segs = [stationary(0, 100, "Home")]; // ends well before sleep window
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});

	it("returns null when the overlapping stationary segment has no place tag", () => {
		const segs = [stationary(0, 1000)]; // no place
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});
});
