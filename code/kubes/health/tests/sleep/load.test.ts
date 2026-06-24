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

	it("falls back to the nearest stationary segment within 6h after the sleep ends", () => {
		// Concrete case: user wakes at 08:19 (window ends), first GPS
		// fix is a stationary period at 11:40 — same morning, same
		// place, but no overlap with the sleep window. The fallback
		// should pick up the post-wake segment's place since it's
		// well within the 6h tolerance.
		const wakeTs = 8 * 3600 + 19 * 60;
		const firstFixStart = 11 * 3600 + 40 * 60;
		const segs = [stationary(firstFixStart, firstFixStart + 3600, "Home")];
		const window = { startTs: 0, endTs: wakeTs };
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("falls back to the nearest stationary segment within 6h before the sleep starts", () => {
		// Evening sleep: starts at 23:43, no stationary segment after
		// (haven't synced tomorrow yet), but the user's last
		// stationary period was 17:22-22:43 @ Home — within 6h before
		// the sleep started.
		const segs = [stationary(17 * 3600 + 22 * 60, 22 * 3600 + 43 * 60, "Home")];
		const window = { startTs: 23 * 3600 + 43 * 60, endTs: 32 * 3600 + 19 * 60 };
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("returns null when the nearest stationary segment is more than 6h from the sleep window", () => {
		// Segment ends at 00:00; window starts at 07:00 — gap is 7h,
		// outside the trust window.
		const segs = [stationary(0, 100, "Home")];
		const window = { startTs: 7 * 3600 + 100, endTs: 8 * 3600 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});

	it("returns null when the overlapping stationary segment has no place tag", () => {
		const segs = [stationary(0, 1000)]; // no place
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});

	it("prefers an overlapping segment over a more-distant nearby one", () => {
		// The user briefly slept on a Tube during a long commute,
		// then a stationary segment at Work started 2h later. We
		// should pick the (in this case non-existent overlapping)
		// segment first — and since there isn't one, fall back to
		// the Work segment via proximity. Verifies tie-breaking
		// across multiple candidates.
		const segs = [stationary(0, 1000, "Home"), stationary(10_000, 20_000, "Work")];
		const window = { startTs: 500, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBe("Home"); // overlap wins
	});
});

describe("derivePlaceForSleep — residential preference for the sleep place", () => {
	// You sleep at a residence, not a hospital. The 2026-06-24 regression:
	// woke at home, walked STRAIGHT out (no stationary Home segment near the
	// wake-up), so the first place you sat still all day was the hospital at
	// 09:29 (a 2h gap). A residential Home stay later in the day (5h gap)
	// must still win the sleep label over the nearer non-residential
	// hospital. Window times mirror that day: wake at 07:00, hospital 09:00,
	// home 12:00.
	const wake = 7 * 3600;
	const window = { startTs: -3600, endTs: wake };
	const hospital = stationary(9 * 3600, 11 * 3600, "University College Hospital"); // gap 2h
	const home = stationary(12 * 3600, 12 * 3600 + 1800, "Home"); // gap 5h

	it("WITHOUT residential info, keeps the old nearest-gap behaviour (the bug)", () => {
		expect(derivePlaceForSleep(window, [hospital, home])).toBe("University College Hospital");
	});

	it("prefers the farther residential place over the nearer non-residential one", () => {
		expect(derivePlaceForSleep(window, [hospital, home], new Set(["Home"]))).toBe("Home");
	});

	it("anchors a residential place even beyond the 6h non-residential cap (got home in the afternoon)", () => {
		// Home stay 8h after wake — outside the 6h cap that bounds a
		// non-residential fallback, but a residence still anchors sleep.
		const lateHome = stationary(15 * 3600, 15 * 3600 + 1800, "Home"); // gap 8h
		expect(derivePlaceForSleep(window, [hospital, lateHome], new Set(["Home"]))).toBe("Home");
	});

	it("falls back to the nearest non-residential place when no residence is in range (genuine hotel/inpatient night)", () => {
		// No residential candidate → the hospital legitimately wins (you
		// really did sleep there).
		expect(derivePlaceForSleep(window, [hospital], new Set(["Home"]))).toBe("University College Hospital");
	});

	it("does not anchor a residence that is more than 12h from the window", () => {
		const farHome = stationary(20 * 3600, 20 * 3600 + 1800, "Home"); // gap 13h
		expect(derivePlaceForSleep(window, [hospital, farHome], new Set(["Home"]))).toBe("University College Hospital");
	});

	it("breaks ties between two residences by proximity", () => {
		const partner = stationary(10 * 3600, 11 * 3600, "Partner's"); // gap 3h
		const homeLate = stationary(14 * 3600, 15 * 3600, "Home"); // gap 7h
		expect(derivePlaceForSleep(window, [partner, homeLate], new Set(["Home", "Partner's"]))).toBe("Partner's");
	});
});
