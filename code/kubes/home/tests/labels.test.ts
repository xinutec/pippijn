import { describe, expect, it } from "vitest";
import { labelFor } from "../src/labels.js";

describe("labelFor", () => {
	it("marks the IQAir as the air-quality sensor and sorts it first", () => {
		const l = labelFor("airvisual");
		expect(l.airQuality).toBe(true);
		expect(l.order).toBe(0);
	});

	it("treats Govee sensors as climate-only", () => {
		const l = labelFor("govee-A562");
		expect(l.airQuality).toBe(false);
		expect(l.order).toBeGreaterThan(0);
	});

	it("falls back to the raw id for an unmapped device", () => {
		const l = labelFor("govee-FFFF");
		expect(l.name).toBe("govee-FFFF");
		expect(l.airQuality).toBe(false);
		expect(l.order).toBe(99);
	});
});
