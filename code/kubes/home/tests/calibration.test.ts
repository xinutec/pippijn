import { describe, expect, it } from "vitest";
import { calibrate } from "../src/calibration.js";

describe("calibrate", () => {
	it("adds the device's offset to temperature", () => {
		const r = calibrate({ device: "airvisual", temp_c: 25.0, humidity: 60 });
		expect(r.temp_c).toBeCloseTo(25.35); // IQAir offset +0.35
	});

	it("leaves an unmapped device unchanged", () => {
		const r = calibrate({ device: "govee-FFFF", temp_c: 25, humidity: 60 });
		expect(r.temp_c).toBe(25);
		expect(r.humidity).toBe(60);
	});

	it("leaves null readings null", () => {
		const r = calibrate({ device: "airvisual", temp_c: null, humidity: null });
		expect(r.temp_c).toBeNull();
		expect(r.humidity).toBeNull();
	});

	it("does not touch humidity when no humidity offset is set", () => {
		const r = calibrate({ device: "govee-A562", temp_c: 26, humidity: 58 });
		expect(r.temp_c).toBeCloseTo(25.6); // -0.40
		expect(r.humidity).toBe(58); // unchanged
	});
});
