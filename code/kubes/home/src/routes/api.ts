import { Hono } from "hono";
import { z } from "zod";
import { offsetFor } from "../calibration.js";
import { db } from "../db/pool.js";
import { decorateDevices } from "../labels.js";
import { MeasurementBatch, MeasurementInput } from "../measurement.js";

// Query parameters for /api/measurements. Validated like the write path — a
// malformed `from`/`to` must 400, not silently return an unfiltered range
// (`new Date("garbage")` is an Invalid Date the driver won't filter on).
export const MeasurementsQuery = z.object({
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional(),
	device: z.string().min(1).max(64).default("airvisual"),
	limit: z.coerce.number().int().positive().max(20000).default(5000),
});

function sensorValues(m: MeasurementInput) {
	return {
		temp_c: m.temp_c ?? null,
		humidity: m.humidity ?? null,
		co2_ppm: m.co2_ppm ?? null,
		pm01: m.pm01 ?? null,
		pm25: m.pm25 ?? null,
		pm10: m.pm10 ?? null,
		aqi_us: m.aqi_us ?? null,
		voc_ppb: m.voc_ppb ?? null,
		battery: m.battery ?? null,
		rssi: m.rssi ?? null,
	};
}

function toRow(m: MeasurementInput) {
	return { device: m.device, ts: m.ts ? new Date(m.ts) : new Date(), ...sensorValues(m) };
}

export function apiRoutes(ingestToken: string): Hono {
	const api = new Hono();

	const authed = (auth: string | undefined) => auth === `Bearer ${ingestToken}`;

	// Token-gated write: the Mac poller POSTs one reading here.
	api.post("/ingest", async (c) => {
		if (!authed(c.req.header("Authorization"))) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const parsed = MeasurementInput.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return c.json({ error: "invalid payload", detail: parsed.error.flatten() }, 400);
		}
		const m = parsed.data;
		await db()
			.insertInto("measurement")
			.values(toRow(m))
			.onDuplicateKeyUpdate(sensorValues(m))
			.execute();
		return c.json({ ok: true });
	});

	// Token-gated bulk write: the backfill importer POSTs arrays of readings.
	// INSERT IGNORE — historical rows are immutable, so an existing (device, ts)
	// key is skipped, making re-runs idempotent.
	api.post("/ingest/batch", async (c) => {
		if (!authed(c.req.header("Authorization"))) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const parsed = MeasurementBatch.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return c.json({ error: "invalid payload", detail: parsed.error.flatten() }, 400);
		}
		const rows = parsed.data.measurements.map(toRow);
		await db().insertInto("measurement").ignore().values(rows).execute();
		return c.json({ ok: true, received: rows.length });
	});

	// Public read: the latest reading per device, each tagged with its display
	// label and ordered for the UI. Drives the per-room tiles.
	api.get("/devices", async (c) => {
		const devices = await db().selectFrom("measurement").select("device").distinct().execute();
		const latest = await Promise.all(
			devices.map((d) =>
				db()
					.selectFrom("measurement")
					.selectAll()
					.where("device", "=", d.device)
					.orderBy("ts", "desc")
					.limit(1)
					.executeTakeFirst(),
			),
		);
		const rows = latest.filter((r): r is NonNullable<typeof r> => r != null);
		// Serve raw + each device's calibration offset; the client applies it so
		// the correction can be toggled.
		const out = decorateDevices(rows).map((d) => ({ ...d, offset: offsetFor(d.device) }));
		return c.json(out);
	});

	// Public read: a time range, oldest first, for charting.
	api.get("/measurements", async (c) => {
		const parsed = MeasurementsQuery.safeParse(c.req.query());
		if (!parsed.success) {
			return c.json({ error: "invalid query", detail: parsed.error.flatten() }, 400);
		}
		const { from, to, device, limit } = parsed.data;
		let q = db()
			.selectFrom("measurement")
			.selectAll()
			.where("device", "=", device)
			.orderBy("ts", "asc");
		if (from) q = q.where("ts", ">=", from);
		if (to) q = q.where("ts", "<=", to);
		const rows = await q.limit(limit).execute();
		return c.json(rows);
	});

	return api;
}
