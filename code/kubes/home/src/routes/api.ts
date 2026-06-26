import { Hono } from "hono";
import { db } from "../db/pool.js";
import { labelFor } from "../labels.js";
import { MeasurementBatch, MeasurementInput } from "../measurement.js";

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

	// Public read: a single device's most recent reading. Defaults to the
	// air-quality sensor — NOT "newest across all devices", which would let a
	// Govee room reading surface in the IQAir hero with blank air-quality fields.
	api.get("/latest", async (c) => {
		const device = c.req.query("device") ?? "airvisual";
		const row = await db()
			.selectFrom("measurement")
			.selectAll()
			.where("device", "=", device)
			.orderBy("ts", "desc")
			.limit(1)
			.executeTakeFirst();
		return c.json(row ?? null);
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
		const out = latest
			.filter((r): r is NonNullable<typeof r> => r != null)
			.map((r) => ({ ...r, label: labelFor(r.device) }))
			.sort((a, b) => a.label.order - b.label.order);
		return c.json(out);
	});

	// Public read: a time range, oldest first, for charting.
	api.get("/measurements", async (c) => {
		const from = c.req.query("from");
		const to = c.req.query("to");
		const device = c.req.query("device") ?? "airvisual";
		const limit = Math.min(Number(c.req.query("limit") ?? 5000) || 5000, 20000);
		let q = db()
			.selectFrom("measurement")
			.selectAll()
			.where("device", "=", device)
			.orderBy("ts", "asc");
		if (from) q = q.where("ts", ">=", new Date(from));
		if (to) q = q.where("ts", "<=", new Date(to));
		const rows = await q.limit(limit).execute();
		return c.json(rows);
	});

	return api;
}
