import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/pool.js";
import type { AppEnv } from "../env.js";
import { isValidTimezone } from "../geo/timezone.js";
import { computeVelocity } from "../geo/velocity.js";
import { requireAuth } from "../middleware/auth.js";
import { NextcloudClient } from "../nextcloud/client.js";
import { fetchTrackPoints, NextcloudNotLinkedError, NextcloudReauthRequiredError } from "../nextcloud/phonetrack.js";
import { buildPhoneTrackFilterValues, computePhoneTrackDatemin } from "../nextcloud/phonetrack-prefs.js";
import { getConnectionStatus } from "../nextcloud/token-manager.js";

/** Subset of the full Config that the API routes actually need. Narrowing
 *  the type here keeps test stubs minimal and surfaces dependency drift
 *  (any new field used by these routes shows up as a type error here). */
export interface ApiRoutesConfig {
	nextcloud: {
		baseUrl: string;
		clientId: string;
		clientSecret: string;
	};
}

const daysParam = z.coerce.number().int().min(1).max(365).default(30);
const dateParam = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.default(() => new Date().toISOString().slice(0, 10));
const tzParam = z.string().refine(isValidTimezone, { message: "Invalid IANA timezone" }).optional();

function nextDay(date: string): string {
	const d = new Date(date);
	d.setDate(d.getDate() + 1);
	return d.toISOString().slice(0, 10);
}

function sinceDate(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() - days);
	return d.toISOString().slice(0, 10);
}

export function apiRoutes(config: ApiRoutesConfig): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use("/*", requireAuth);

	app.get("/me", async (c) => {
		const { userId, displayName } = c.get("session");
		const [fitbit, ncStatus] = await Promise.all([
			db().selectFrom("tokens").select("user_id").where("user_id", "=", userId).executeTakeFirst(),
			getConnectionStatus(userId),
		]);
		return c.json({
			userId,
			displayName,
			fitbitLinked: !!fitbit,
			nextcloudLinked: ncStatus !== "not_linked", // legacy boolean kept for compatibility
			connections: {
				nextcloud: { status: ncStatus },
				fitbit: { status: fitbit ? "active" : "not_linked" },
			},
		});
	});

	app.get("/activity", async (c) => {
		const uid = c.get("session").userId;
		const days = daysParam.parse(c.req.query("days"));
		const rows = await db()
			.selectFrom("daily_activity")
			.selectAll()
			.where("user_id", "=", uid)
			.where("date", ">=", sinceDate(days))
			.orderBy("date")
			.execute();
		return c.json(rows);
	});

	app.get("/sleep", async (c) => {
		const uid = c.get("session").userId;
		const days = daysParam.parse(c.req.query("days"));
		const rows = await db()
			.selectFrom("sleep")
			.selectAll()
			.where("user_id", "=", uid)
			.where("date", ">=", sinceDate(days))
			.orderBy("date")
			.execute();
		return c.json(rows);
	});

	app.get("/sleep/stages", async (c) => {
		const uid = c.get("session").userId;
		const date = dateParam.parse(c.req.query("date"));
		// Find the main sleep log for this date
		const sleepLog = await db()
			.selectFrom("sleep")
			.select("log_id")
			.where("user_id", "=", uid)
			.where("date", "=", date)
			.where("is_main_sleep", "=", true)
			.executeTakeFirst();

		if (!sleepLog) return c.json([]);

		const stages = await db()
			.selectFrom("sleep_stages")
			.selectAll()
			.where("user_id", "=", uid)
			.where("sleep_log_id", "=", sleepLog.log_id)
			.orderBy("ts")
			.execute();
		return c.json(stages);
	});

	app.get("/heartrate/zones", async (c) => {
		const uid = c.get("session").userId;
		const days = daysParam.parse(c.req.query("days"));
		const rows = await db()
			.selectFrom("heart_rate_zones")
			.selectAll()
			.where("user_id", "=", uid)
			.where("date", ">=", sinceDate(days))
			.orderBy("date")
			.orderBy("zone_name")
			.execute();
		return c.json(rows);
	});

	app.get("/heartrate/intraday", async (c) => {
		const uid = c.get("session").userId;
		const date = dateParam.parse(c.req.query("date"));
		const rows = await db()
			.selectFrom("heart_rate_intraday")
			.selectAll()
			.where("user_id", "=", uid)
			.where("ts", ">=", date)
			.where("ts", "<", nextDay(date))
			.orderBy("ts")
			.execute();
		return c.json(rows);
	});

	app.get("/body", async (c) => {
		const uid = c.get("session").userId;
		const days = daysParam.parse(c.req.query("days"));
		const rows = await db()
			.selectFrom("body")
			.selectAll()
			.where("user_id", "=", uid)
			.where("date", ">=", sinceDate(days))
			.orderBy("date")
			.execute();
		return c.json(rows);
	});

	app.get("/spo2", async (c) => {
		const uid = c.get("session").userId;
		const days = daysParam.parse(c.req.query("days"));
		const rows = await db()
			.selectFrom("spo2_daily")
			.selectAll()
			.where("user_id", "=", uid)
			.where("date", ">=", sinceDate(days))
			.orderBy("date")
			.execute();
		return c.json(rows);
	});

	app.get("/hrv", async (c) => {
		const uid = c.get("session").userId;
		const days = daysParam.parse(c.req.query("days"));
		const rows = await db()
			.selectFrom("hrv_daily")
			.selectAll()
			.where("user_id", "=", uid)
			.where("date", ">=", sinceDate(days))
			.orderBy("date")
			.execute();
		return c.json(rows);
	});

	app.get("/breathing", async (c) => {
		const uid = c.get("session").userId;
		const days = daysParam.parse(c.req.query("days"));
		const rows = await db()
			.selectFrom("breathing_rate")
			.selectAll()
			.where("user_id", "=", uid)
			.where("date", ">=", sinceDate(days))
			.orderBy("date")
			.execute();
		return c.json(rows);
	});

	app.get("/temperature", async (c) => {
		const uid = c.get("session").userId;
		const days = daysParam.parse(c.req.query("days"));
		const rows = await db()
			.selectFrom("skin_temperature")
			.selectAll()
			.where("user_id", "=", uid)
			.where("date", ">=", sinceDate(days))
			.orderBy("date")
			.execute();
		return c.json(rows);
	});

	app.get("/devices", async (c) => {
		const uid = c.get("session").userId;
		const rows = await db().selectFrom("devices").selectAll().where("user_id", "=", uid).execute();
		return c.json(rows);
	});

	app.get("/locations", async (c) => {
		const uid = c.get("session").userId;
		const date = dateParam.parse(c.req.query("date"));
		try {
			const points = await fetchTrackPoints(config, uid, date, nextDay(date));
			return c.json(points);
		} catch (e) {
			// Unlinked Nextcloud → empty list (200) so the frontend can
			// surface the link CTA via /api/me. Reauth required → 409
			// with a structured error code so the interceptor can fire
			// the global banner.
			if (e instanceof NextcloudNotLinkedError) return c.json([]);
			if (e instanceof NextcloudReauthRequiredError) return c.json({ error: "nextcloud_reauth_required" }, 409);
			console.error(`/api/locations failed for user=${uid} date=${date}:`, e);
			return c.json({ error: "locations fetch failed" }, 400);
		}
	});

	app.get("/velocity", async (c) => {
		const uid = c.get("session").userId;
		const date = dateParam.parse(c.req.query("date"));
		const tz = tzParam.parse(c.req.query("tz"));
		try {
			const result = await computeVelocity(config, uid, date, tz);
			return c.json(result);
		} catch (e) {
			// Graceful degradation: unlinked → empty timeline (200).
			// Reauth required → 409 with structured error so the SPA
			// can render the reconnect banner instead of silently
			// rendering "No timeline data available".
			if (e instanceof NextcloudNotLinkedError) return c.json({ points: [], segments: [] });
			if (e instanceof NextcloudReauthRequiredError) return c.json({ error: "nextcloud_reauth_required" }, 409);
			console.error(`/api/velocity failed for user=${uid} date=${date} tz=${tz}:`, e);
			return c.json({ error: "velocity computation failed" }, 400);
		}
	});

	app.get("/sync-state", async (c) => {
		const uid = c.get("session").userId;
		const rows = await db().selectFrom("sync_state").selectAll().where("user_id", "=", uid).execute();
		return c.json(rows);
	});

	app.post("/phonetrack/sync-filter", async (c) => {
		const uid = c.get("session").userId;
		const tz = tzParam.parse(c.req.query("tz")) ?? "UTC";

		const datemin = computePhoneTrackDatemin(new Date(), tz);
		const values = buildPhoneTrackFilterValues(datemin);

		try {
			const nc = new NextcloudClient(uid, config.nextcloud);
			await nc.put("/index.php/apps/phonetrack/saveOptionValues", { values });
			return c.json({ ok: true, datemin });
		} catch (e) {
			if (e instanceof NextcloudNotLinkedError) return c.json({ error: "nextcloud_not_linked" }, 412);
			if (e instanceof NextcloudReauthRequiredError) return c.json({ error: "nextcloud_reauth_required" }, 409);
			console.error(`/api/phonetrack/sync-filter failed for user=${uid}:`, e);
			return c.json({ error: "phonetrack sync-filter failed" }, 502);
		}
	});

	return app;
}
