import { describe, expect, it } from "vitest";
import { backfillStreamDay, shouldAdvanceEmptyStreak } from "../src/backfill.js";

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
