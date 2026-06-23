import { describe, expect, it } from "vitest";
import { MeasurementBatch, MeasurementInput } from "../src/measurement.js";

describe("MeasurementInput", () => {
	it("accepts a full AirVisual reading", () => {
		const r = MeasurementInput.safeParse({
			ts: "2026-06-23T14:30:00.000Z",
			device: "airvisual",
			temp_c: 25.8,
			humidity: 68,
			co2_ppm: 695,
			pm01: 2,
			pm25: 2,
			pm10: 2,
			aqi_us: 11,
			voc_ppb: null,
		});
		expect(r.success).toBe(true);
	});

	it("defaults device and allows missing sensors", () => {
		const r = MeasurementInput.parse({ temp_c: 20 });
		expect(r.device).toBe("airvisual");
		expect(r.humidity).toBeUndefined();
	});

	it("rejects out-of-range humidity", () => {
		expect(MeasurementInput.safeParse({ humidity: 250 }).success).toBe(false);
	});

	it("rejects a non-numeric temperature", () => {
		expect(MeasurementInput.safeParse({ temp_c: "hot" }).success).toBe(false);
	});

	it("rejects a malformed timestamp", () => {
		expect(MeasurementInput.safeParse({ ts: "yesterday" }).success).toBe(false);
	});
});

describe("MeasurementBatch", () => {
	it("accepts an array of readings", () => {
		const r = MeasurementBatch.safeParse({
			measurements: [{ temp_c: 20 }, { temp_c: 21, humidity: 50 }],
		});
		expect(r.success).toBe(true);
	});

	it("rejects an empty array", () => {
		expect(MeasurementBatch.safeParse({ measurements: [] }).success).toBe(false);
	});

	it("rejects more than 5000 readings", () => {
		const many = Array.from({ length: 5001 }, () => ({ temp_c: 20 }));
		expect(MeasurementBatch.safeParse({ measurements: many }).success).toBe(false);
	});

	it("rejects a bad reading inside the array", () => {
		expect(MeasurementBatch.safeParse({ measurements: [{ humidity: 250 }] }).success).toBe(false);
	});
});
