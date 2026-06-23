import { z } from "zod";

// One environmental reading pushed by the Mac's airvisual poller. Every sensor
// field is optional/nullable — a sensor may not report (e.g. the AirVisual VOC
// channel returns -1, which the poller maps to null).
export const MeasurementInput = z.object({
	// ISO-8601 instant; the server defaults to "now" if omitted.
	ts: z.string().datetime().optional(),
	device: z.string().min(1).max(64).default("airvisual"),
	temp_c: z.number().nullable().optional(),
	humidity: z.number().min(0).max(100).nullable().optional(),
	co2_ppm: z.number().int().nullable().optional(),
	pm01: z.number().min(0).nullable().optional(),
	pm25: z.number().min(0).nullable().optional(),
	pm10: z.number().min(0).nullable().optional(),
	aqi_us: z.number().int().min(0).nullable().optional(),
	voc_ppb: z.number().int().nullable().optional(),
});

export type MeasurementInput = z.infer<typeof MeasurementInput>;

// Bulk ingest (the backfill importer): an array of readings in one request.
// Capped so a single request stays well within MariaDB's max_allowed_packet.
export const MeasurementBatch = z.object({
	measurements: z.array(MeasurementInput).min(1).max(5000),
});

export type MeasurementBatch = z.infer<typeof MeasurementBatch>;
