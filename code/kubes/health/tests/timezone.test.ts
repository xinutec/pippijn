import { describe, expect, it } from "vitest";

/**
 * PhoneTrack stores timestamps as unix epoch but the values represent
 * LOCAL time, not UTC. This is the same behavior as Fitbit.
 *
 * When displaying PhoneTrack timestamps:
 * - Use UTC methods (getUTCHours etc) to extract the components
 * - Do NOT apply timezone offset — the offset is already baked in
 *
 * This test documents this behavior so we don't add timezone
 * corrections that double-offset the display.
 */

function formatPhoneTrackTime(unixTs: number): string {
	const d = new Date(unixTs * 1000);
	// Use UTC methods because the timestamp already represents local time
	const h = d.getUTCHours().toString().padStart(2, "0");
	const m = d.getUTCMinutes().toString().padStart(2, "0");
	return `${h}:${m}`;
}

describe("PhoneTrack timestamp handling", () => {
	it("displays timestamps as-is without timezone conversion", () => {
		// PhoneTrack recorded 16:09 local time.
		// The unix timestamp encodes this as if it were UTC.
		// We must display 16:09, not 18:09 (UTC+2).
		const ts = 1778337000; // some PhoneTrack timestamp
		const display = formatPhoneTrackTime(ts);
		// The exact time doesn't matter for this test —
		// what matters is we use getUTCHours, not getHours
		const d = new Date(ts * 1000);
		expect(display).toBe(
			`${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}`,
		);
	});
});
