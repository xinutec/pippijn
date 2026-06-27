import { describe, expect, it } from "vitest";
import { offsetFor } from "../src/calibration.js";

describe("offsetFor", () => {
	it("returns a device's temperature offset", () => {
		expect(offsetFor("airvisual").temp_c).toBeCloseTo(0.35);
		expect(offsetFor("govee-A562").temp_c).toBeCloseTo(-0.4);
	});

	it("returns an empty object for an unmapped device", () => {
		expect(offsetFor("govee-FFFF")).toEqual({});
	});
});
