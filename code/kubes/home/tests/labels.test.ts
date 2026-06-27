import { describe, expect, it } from "vitest";
import { decorateDevices, labelFor } from "../src/labels.js";

describe("labelFor", () => {
	it("marks the IQAir as the air-quality sensor and sorts it first", () => {
		const l = labelFor("airvisual");
		expect(l.airQuality).toBe(true);
		expect(l.order).toBe(0);
		expect(l.type).toBe("IQAir AirVisual Pro");
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
		expect(l.type).toBe("Unknown");
	});
});

describe("decorateDevices", () => {
	it("attaches labels and orders the air-quality sensor first", () => {
		const out = decorateDevices([
			{ device: "govee-525D", temp_c: 26 },
			{ device: "airvisual", temp_c: 25 },
			{ device: "govee-A562", temp_c: 24 },
		]);
		expect(out.map((d) => d.device)).toEqual(["airvisual", "govee-A562", "govee-525D"]);
		expect(out[0]?.label.airQuality).toBe(true);
		expect(out[0]?.temp_c).toBe(25); // original fields preserved
	});

	it("sorts unmapped devices last and labels them by their id", () => {
		const out = decorateDevices([{ device: "govee-FFFF" }, { device: "airvisual" }]);
		expect(out.map((d) => d.device)).toEqual(["airvisual", "govee-FFFF"]);
		expect(out[1]?.label.name).toBe("govee-FFFF");
	});

	it("returns an empty list unchanged", () => {
		expect(decorateDevices([])).toEqual([]);
	});
});
