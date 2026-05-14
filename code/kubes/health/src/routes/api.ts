import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/pool.js";
import type { AppEnv } from "../env.js";
import { getConnectionStatus as getFitbitConnectionStatus } from "../fitbit/token-manager.js";
import { isValidTimezone } from "../geo/timezone.js";
import { computeVelocity } from "../geo/velocity.js";
import { requireAuth } from "../middleware/auth.js";
import { requireOwnerOnly } from "../middleware/share-auth.js";
import { NextcloudClient } from "../nextcloud/client.js";
import { getConnectionStatus as getNextcloudConnectionStatus, storeCredentials } from "../nextcloud/credentials.js";
import {
	type LoginFlowInitiation,
	type LoginFlowResult,
	parseInitiateResponse,
	pollLoginFlow,
} from "../nextcloud/login-flow.js";
import { fetchTrackPoints, NextcloudNotLinkedError, NextcloudReauthRequiredError } from "../nextcloud/phonetrack.js";
import { buildPhoneTrackFilterValues, computePhoneTrackDatemin } from "../nextcloud/phonetrack-prefs.js";
import { getShareForUser, revokeShareForUser, rotateShareForUser } from "../share/repository.js";
import { buildShareUrl } from "../share/token.js";
import { getVelocityCached } from "./velocity-cache.js";

/** Subset of the full Config that the API routes actually need. Narrowing
 *  the type here keeps test stubs minimal and surfaces dependency drift
 *  (any new field used by these routes shows up as a type error here). */
export interface ApiRoutesConfig {
	nextcloud: {
		baseUrl: string;
	};
	/** Public origin where the dashboard is served from. Used to build
	 *  share URLs that get sent to recipients. */
	publicBaseUrl: string;
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

/** "Earliest date this request is allowed to see" for the given days
 *  parameter. For owner sessions: sinceDate(days). For share-viewer
 *  sessions: max(sinceDate(days), shareViewer.from), so the share's
 *  date window strictly caps the multi-day read regardless of how
 *  large `days` is. */
function sinceDateForSession(session: { shareViewer?: { from: string; to: string } }, days: number): string {
	const owner = sinceDate(days);
	if (!session.shareViewer) return owner;
	return owner < session.shareViewer.from ? session.shareViewer.from : owner;
}

/** True iff a single-day request for `date` should be rejected
 *  because the session is a share-viewer and the date is outside
 *  the share window. */
function isDateOutsideShareWindow(session: { shareViewer?: { from: string; to: string } }, date: string): boolean {
	if (!session.shareViewer) return false;
	return date < session.shareViewer.from || date > session.shareViewer.to;
}

export function apiRoutes(config: ApiRoutesConfig): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use("/*", requireAuth);
	app.use("/*", requireOwnerOnly);

	app.get("/me", async (c) => {
		const session = c.get("session");
		const { userId, displayName, shareViewer } = session;
		const [ncStatus, fbStatus] = await Promise.all([
			getNextcloudConnectionStatus(userId),
			getFitbitConnectionStatus(userId),
		]);
		return c.json({
			userId,
			displayName,
			// Legacy booleans kept for older SPA builds. New code reads
			// the typed `connections` object below.
			fitbitLinked: fbStatus !== "not_linked",
			nextcloudLinked: ncStatus !== "not_linked",
			connections: {
				nextcloud: { status: ncStatus },
				fitbit: { status: fbStatus },
			},
			// Present iff this request was authenticated via share token.
			// Lets the SPA know the navigable date range so it can clamp
			// the prev/next-day arrows.
			shareWindow: shareViewer ?? null,
		});
	});

	app.get("/activity", async (c) => {
		const uid = c.get("session").userId;
		const days = daysParam.parse(c.req.query("days"));
		const rows = await db()
			.selectFrom("daily_activity")
			.selectAll()
			.where("user_id", "=", uid)
			.where("date", ">=", sinceDateForSession(c.get("session"), days))
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
			.where("date", ">=", sinceDateForSession(c.get("session"), days))
			.orderBy("date")
			.execute();
		return c.json(rows);
	});

	app.get("/sleep/stages", async (c) => {
		const session = c.get("session");
		const uid = session.userId;
		const date = dateParam.parse(c.req.query("date"));
		if (isDateOutsideShareWindow(session, date)) return c.json([]);
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
			.where("date", ">=", sinceDateForSession(c.get("session"), days))
			.orderBy("date")
			.orderBy("zone_name")
			.execute();
		return c.json(rows);
	});

	app.get("/heartrate/intraday", async (c) => {
		const session = c.get("session");
		const uid = session.userId;
		const date = dateParam.parse(c.req.query("date"));
		if (isDateOutsideShareWindow(session, date)) return c.json([]);
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
			.where("date", ">=", sinceDateForSession(c.get("session"), days))
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
			.where("date", ">=", sinceDateForSession(c.get("session"), days))
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
			.where("date", ">=", sinceDateForSession(c.get("session"), days))
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
			.where("date", ">=", sinceDateForSession(c.get("session"), days))
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
			.where("date", ">=", sinceDateForSession(c.get("session"), days))
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
		const session = c.get("session");
		const uid = session.userId;
		const date = dateParam.parse(c.req.query("date"));
		if (isDateOutsideShareWindow(session, date)) return c.json([]);
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
		const session = c.get("session");
		const uid = session.userId;
		const date = dateParam.parse(c.req.query("date"));
		const tz = tzParam.parse(c.req.query("tz"));
		// Share-viewers can only see dates inside the share's window.
		if (session.shareViewer && (date < session.shareViewer.from || date > session.shareViewer.to)) {
			return c.json({ error: "out_of_share_window", from: session.shareViewer.from, to: session.shareViewer.to }, 403);
		}
		try {
			// Cache result by (user, date, tz) — see velocity-cache.ts.
			// Repeat views in the same session return in tens of ms;
			// pod restart clears the cache so logic changes go live
			// on the first request after deploy.
			const cacheKey = `${uid}|${date}|${tz ?? ""}`;
			const result = await getVelocityCached(cacheKey, () => computeVelocity(config, uid, date, tz));
			return c.json(result);
		} catch (e) {
			// Graceful degradation: unlinked → empty timeline (200).
			// Reauth required → 409 with structured error so the SPA
			// can render the reconnect banner instead of silently
			// rendering "No timeline data available".
			if (e instanceof NextcloudNotLinkedError) return c.json({ points: [], segments: [], states: [] });
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

	// ─── Share-link management ────────────────────────────────────────
	// GET /api/share → current share status (token, url, days_back) or null
	// POST /api/share → create/rotate; body { days_back?: number } (default 7)
	// DELETE /api/share → revoke the current token
	//
	// The companion public read endpoint lives outside /api so it skips
	// requireAuth — it authenticates strictly via the URL token.
	app.get("/share", async (c) => {
		const uid = c.get("session").userId;
		const row = await getShareForUser(uid);
		if (!row) return c.json({ active: false });
		return c.json({
			active: true,
			token: row.token,
			url: buildShareUrl(config.publicBaseUrl, row.token),
			daysBack: row.days_back,
			createdAt: row.created_at.toISOString(),
			lastAccessedAt: row.last_accessed_at?.toISOString() ?? null,
		});
	});

	app.post("/share", async (c) => {
		const uid = c.get("session").userId;
		let daysBack = 7;
		try {
			const body = (await c.req.json()) as { daysBack?: unknown };
			if (typeof body.daysBack === "number" && Number.isFinite(body.daysBack)) {
				daysBack = Math.max(1, Math.min(365, Math.floor(body.daysBack)));
			}
		} catch {
			// no body → use default
		}
		const row = await rotateShareForUser(uid, daysBack);
		return c.json({
			active: true,
			token: row.token,
			url: buildShareUrl(config.publicBaseUrl, row.token),
			daysBack: row.days_back,
			createdAt: row.created_at.toISOString(),
			lastAccessedAt: row.last_accessed_at?.toISOString() ?? null,
		});
	});

	app.delete("/share", async (c) => {
		const uid = c.get("session").userId;
		await revokeShareForUser(uid);
		return c.body(null, 204);
	});

	app.post("/client-log", async (c) => {
		// Diagnostic logging endpoint: front-end posts a small JSON
		// blob, we write it to pod stdout where `kubectl logs` (or a
		// human reviewing the deployment logs) can read it. Keeps a
		// human in the loop for debugging UX issues that can't be
		// observed remotely.
		//
		// Auth-gated via the route group's requireAuth middleware so
		// random clients can't pollute the log stream. Body is capped
		// to a few KB to bound damage from a buggy or hostile client.
		const uid = c.get("session").userId;
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body || typeof body !== "object") {
			return c.json({ error: "expected object" }, 400);
		}
		const event = String((body as { event?: unknown }).event ?? "").slice(0, 100);
		const data = (body as { data?: unknown }).data;
		const dataStr = data === undefined ? "" : JSON.stringify(data).slice(0, 4000);
		console.log(`[client/${uid}] ${event}${dataStr ? ` ${dataStr}` : ""}`);
		return c.body(null, 204);
	});

	// ─── Nextcloud Login Flow v2 connect flow ─────────────────────────
	// Per-user in-flight state for an ongoing Login Flow v2. Cleared on
	// success/failure/timeout. Single user → at most one pending flow
	// per user at a time; new POST /init cancels any previous.
	interface FlowState {
		readonly initiation: LoginFlowInitiation;
		readonly started: number;
		result: { kind: "pending" } | { kind: "ready"; creds: LoginFlowResult } | { kind: "failed"; error: string };
	}
	const pendingFlows = new Map<string, FlowState>();

	app.post("/nextcloud/connect/init", async (c) => {
		const uid = c.get("session").userId;
		// Initiate Login Flow v2 with NC. Returns a loginUrl the user
		// should open in a browser to grant access, and we kick off
		// background polling to detect completion.
		const res = await fetch(`${config.nextcloud.baseUrl}/index.php/login/v2`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": "health.xinutec.org" },
		});
		if (!res.ok) {
			const body = await res.text();
			console.error(`NC login-flow init failed for user=${uid}: ${res.status} ${body}`);
			return c.json({ error: "nextcloud_init_failed" }, 502);
		}
		const initiation = parseInitiateResponse(await res.json());

		const flow: FlowState = { initiation, started: Date.now(), result: { kind: "pending" } };
		pendingFlows.set(uid, flow);

		// Background poll until success / failure / 5-min deadline.
		// On success we persist credentials and mark active; the SPA
		// observes the change via GET /nextcloud/connect/status.
		void (async () => {
			try {
				const creds = await pollLoginFlow(initiation, { intervalMs: 2_000, deadlineMs: 5 * 60_000 });
				await storeCredentials(uid, { loginName: creds.loginName, appPassword: creds.appPassword });
				flow.result = { kind: "ready", creds };
				console.log(`NC login-flow complete for user=${uid} (loginName=${creds.loginName})`);
			} catch (e) {
				flow.result = { kind: "failed", error: (e as Error).message };
				console.warn(`NC login-flow failed for user=${uid}: ${(e as Error).message}`);
			}
		})();

		return c.json({ loginUrl: initiation.loginUrl });
	});

	app.get("/nextcloud/connect/status", async (c) => {
		const uid = c.get("session").userId;
		const flow = pendingFlows.get(uid);
		if (!flow) return c.json({ state: "idle" });
		if (flow.result.kind === "pending") return c.json({ state: "pending" });
		if (flow.result.kind === "ready") {
			// Once SPA has observed "ready" we can clear; the credentials
			// are persisted and getConnectionStatus will report "active".
			pendingFlows.delete(uid);
			return c.json({ state: "ready", loginName: flow.result.creds.loginName });
		}
		pendingFlows.delete(uid);
		return c.json({ state: "failed", error: flow.result.error });
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
