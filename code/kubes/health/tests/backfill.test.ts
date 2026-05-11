import { describe, expect, it } from "vitest";
import {
	backfillStreamDay,
	prevDayBounded,
	shouldAdvanceEmptyStreak,
	sortStreamsByCursorRecency,
} from "../src/backfill.js";

describe("backfillStreamDay", () => {
	it("returns ok with the synced point count on success", async () => {
		const r = await backfillStreamDay(async () => 1234, "2026-01-01");
		expect(r).toEqual({ ok: true, points: 1234 });
	});

	it("returns ok with 0 points when the day was genuinely empty", async () => {
		const r = await backfillStreamDay(async () => 0, "2026-01-01");
		expect(r).toEqual({ ok: true, points: 0 });
	});

	it("returns not-ok when the underlying sync throws (transient API error)", async () => {
		const err = new Error("Fitbit 500");
		const r = await backfillStreamDay(async () => {
			throw err;
		}, "2026-01-01");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe(err);
	});

	it("returns not-ok for a network-shaped failure (no specific Error type)", async () => {
		const r = await backfillStreamDay(async () => {
			throw "ECONNRESET";
		}, "2026-01-01");
		expect(r.ok).toBe(false);
	});
});

describe("shouldAdvanceEmptyStreak", () => {
	it("advances streak only for a successful day with zero points", () => {
		expect(shouldAdvanceEmptyStreak({ ok: true, points: 0 })).toBe(true);
	});

	it("does NOT advance streak for a successful day with data", () => {
		expect(shouldAdvanceEmptyStreak({ ok: true, points: 1 })).toBe(false);
		expect(shouldAdvanceEmptyStreak({ ok: true, points: 21000 })).toBe(false);
	});

	it("does NOT advance streak when the call failed (the data-loss bug)", () => {
		// This is the regression we're fixing: a transient Fitbit/network
		// failure must NOT count as an empty day, otherwise 14 consecutive
		// blips silently mark backfill complete and truncate history.
		expect(shouldAdvanceEmptyStreak({ ok: false, error: new Error("any") })).toBe(false);
	});
});

describe("sortStreamsByCursorRecency", () => {
	const today = "2026-05-10";
	const stream = (name: string) => ({ name });
	const names = (streams: Array<{ name: string }>) => streams.map((s) => s.name);

	it("returns the input order when nothing is to be sorted", () => {
		expect(sortStreamsByCursorRecency([], new Map(), today)).toEqual([]);
		expect(names(sortStreamsByCursorRecency([stream("a")], new Map(), today))).toEqual(["a"]);
	});

	it("a freshly-deployed stream (no stored cursor) sorts FIRST", () => {
		// hr_intraday is deep in 2024; steps_intraday just deployed (no row).
		// Steps must run before hr to catch up.
		const cursors = new Map([["hr_intraday", "2024-08-08"]]);
		const sorted = sortStreamsByCursorRecency([stream("hr_intraday"), stream("steps_intraday")], cursors, today);
		expect(names(sorted)).toEqual(["steps_intraday", "hr_intraday"]);
	});

	it("most-recent cursor sorts FIRST when both streams have stored cursors", () => {
		const cursors = new Map([
			["hr_intraday", "2024-08-08"],
			["steps_intraday", "2026-04-01"],
		]);
		const sorted = sortStreamsByCursorRecency([stream("hr_intraday"), stream("steps_intraday")], cursors, today);
		expect(names(sorted)).toEqual(["steps_intraday", "hr_intraday"]);
	});

	it("identical cursors preserve input order (stable)", () => {
		const cursors = new Map([
			["hr_intraday", "2025-01-01"],
			["steps_intraday", "2025-01-01"],
		]);
		const sorted = sortStreamsByCursorRecency([stream("hr_intraday"), stream("steps_intraday")], cursors, today);
		expect(names(sorted)).toEqual(["hr_intraday", "steps_intraday"]);
	});

	it("multiple fresh streams (no cursor) preserve input order among themselves", () => {
		// Both new → both fall back to today → tie → stable.
		const sorted = sortStreamsByCursorRecency([stream("hrv"), stream("steps")], new Map(), today);
		expect(names(sorted)).toEqual(["hrv", "steps"]);
	});

	it("orders three streams correctly across all states (fresh / recent / old)", () => {
		const cursors = new Map([
			["hr_intraday", "2024-08-08"],
			["steps_intraday", "2025-12-01"],
			// "hrv_intraday" missing → fallback today
		]);
		const sorted = sortStreamsByCursorRecency(
			[stream("hr_intraday"), stream("steps_intraday"), stream("hrv_intraday")],
			cursors,
			today,
		);
		// Order: hrv (today, freshest) → steps (2025-12-01) → hr (2024-08-08)
		expect(names(sorted)).toEqual(["hrv_intraday", "steps_intraday", "hr_intraday"]);
	});

	it("does not mutate the input array", () => {
		const input = [stream("a"), stream("b")];
		const cursors = new Map([
			["a", "2024-01-01"],
			["b", "2025-01-01"],
		]);
		sortStreamsByCursorRecency(input, cursors, today);
		expect(names(input)).toEqual(["a", "b"]);
	});
});

describe("prevDayBounded", () => {
	// Decrement a YYYY-MM-DD date string by one day, but return null when
	// the result would be earlier than `floor`. Used by the backfill loop
	// to refuse to walk past a sentinel "Fitbit didn't exist yet" date —
	// without this guard, a loop bug elsewhere could push the cursor into
	// negative years, producing malformed date strings like "-000026-02"
	// (which is what happened to pippijn's steps backfill cursor).

	it("returns the previous day for a normal date", () => {
		expect(prevDayBounded("2026-01-02", "2000-01-01")).toBe("2026-01-01");
	});

	it("crosses month boundaries correctly", () => {
		expect(prevDayBounded("2026-03-01", "2000-01-01")).toBe("2026-02-28");
	});

	it("crosses year boundaries correctly", () => {
		expect(prevDayBounded("2025-01-01", "2000-01-01")).toBe("2024-12-31");
	});

	it("returns null when the previous day is before the floor", () => {
		expect(prevDayBounded("2000-01-01", "2000-01-01")).toBeNull();
	});

	it("returns null when the input is already before the floor", () => {
		expect(prevDayBounded("1999-12-31", "2000-01-01")).toBeNull();
	});

	it("returns null for malformed input (never produces -000026-02)", () => {
		expect(prevDayBounded("-000026-02", "2000-01-01")).toBeNull();
		expect(prevDayBounded("garbage", "2000-01-01")).toBeNull();
		expect(prevDayBounded("", "2000-01-01")).toBeNull();
	});
});
