import { describe, expect, it } from "vitest";
import { offsetFor } from "../src/calibration.js";

describe("offsetFor", () => {
	// The exact offsets are re-derived from live data (see doc/calibration.md), so
	// this asserts the shape — every known device carries a finite temp_c — rather
	// than pinning magic numbers that change on every re-calibration.
	it("returns a finite temperature offset for each known device", () => {
		for (const device of ["airvisual", "govee-A562", "govee-525D", "govee-B7AC", "govee-267F"]) {
			expect(Number.isFinite(offsetFor(device).temp_c)).toBe(true);
		}
	});

	it("returns an empty object for an unmapped device", () => {
		expect(offsetFor("govee-FFFF")).toEqual({});
	});
});
