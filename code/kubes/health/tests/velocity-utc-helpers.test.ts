import { describe, expect, it } from "vitest";
import { utcDatetimeStrToSeconds, utcSecondsToDatetimeStr } from "../src/geo/velocity.js";

describe("utcSecondsToDatetimeStr", () => {
	it("formats unix seconds as 'YYYY-MM-DD HH:MM:SS' UTC", () => {
		// 1778414400 = 2026-05-10T12:00:00Z
		expect(utcSecondsToDatetimeStr(1778414400)).toBe("2026-05-10 12:00:00");
	});

	it("rounds away sub-second precision", () => {
		expect(utcSecondsToDatetimeStr(1778414400)).toBe("2026-05-10 12:00:00");
	});
});

describe("utcDatetimeStrToSeconds", () => {
	it("parses a DATE_FORMAT-shaped UTC string", () => {
		expect(utcDatetimeStrToSeconds("2026-05-10 12:00:00")).toBe(1778414400);
	});

	it("parses an ISO-shaped string from the mariadb driver", () => {
		// fitbitTsToUnix accepts this shape — the driver hangs a misleading
		// Z suffix on a DATETIME serialised to ISO. We treat components as
		// UTC regardless.
		expect(utcDatetimeStrToSeconds("2026-05-10T12:00:00.000Z")).toBe(1778414400);
	});

	it("parses a Date object from the mariadb driver", () => {
		// REGRESSION: an earlier version of this helper called `s.replace(...)`,
		// which crashed at runtime on the Date the driver returns for a raw
		// SELECT against a DATETIME column. The fix accepts both inputs.
		const driverDate = new Date("2026-05-10T12:00:00.000Z");
		expect(utcDatetimeStrToSeconds(driverDate)).toBe(1778414400);
	});

	it("returns NaN for a malformed input", () => {
		expect(Number.isNaN(utcDatetimeStrToSeconds("not a date"))).toBe(true);
	});

	it("round-trips with utcSecondsToDatetimeStr", () => {
		const unix = 1778414400;
		expect(utcDatetimeStrToSeconds(utcSecondsToDatetimeStr(unix))).toBe(unix);
	});
});
