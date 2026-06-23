import { Hono } from "hono";
import { db } from "../db/pool.js";
import { MeasurementInput } from "../measurement.js";

export function apiRoutes(ingestToken: string): Hono {
	const api = new Hono();

	// Token-gated write: the Mac poller POSTs readings here.
	api.post("/ingest", async (c) => {
		if (c.req.header("Authorization") !== `Bearer ${ingestToken}`) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const body = await c.req.json().catch(() => null);
		const parsed = MeasurementInput.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "invalid payload", detail: parsed.error.flatten() }, 400);
		}
		const m = parsed.data;
		const values = {
			temp_c: m.temp_c ?? null,
			humidity: m.humidity ?? null,
			co2_ppm: m.co2_ppm ?? null,
			pm01: m.pm01 ?? null,
			pm25: m.pm25 ?? null,
			pm10: m.pm10 ?? null,
			aqi_us: m.aqi_us ?? null,
			voc_ppb: m.voc_ppb ?? null,
		};
		await db()
			.insertInto("measurement")
			.values({ device: m.device, ts: m.ts ? new Date(m.ts) : new Date(), ...values })
			.onDuplicateKeyUpdate(values)
			.execute();
		return c.json({ ok: true });
	});

	// Public read: the most recent reading.
	api.get("/latest", async (c) => {
		const row = await db()
			.selectFrom("measurement")
			.selectAll()
			.orderBy("ts", "desc")
			.limit(1)
			.executeTakeFirst();
		return c.json(row ?? null);
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
