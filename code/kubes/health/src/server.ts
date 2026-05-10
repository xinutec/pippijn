import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { initPool, withConnection } from "./db/pool.js";
import { migrate } from "./db/schema.js";
import type { AppEnv } from "./env.js";
import { sessionMiddleware } from "./middleware/session.js";
import { apiRoutes } from "./routes/api.js";
import { fitbitOAuthRoutes } from "./routes/fitbit-oauth.js";
import { nextcloudOAuthRoutes } from "./routes/nextcloud-oauth.js";

const config = loadConfig();
initPool(config.db);

// Run migrations on startup
await withConnection(migrate);

const app = new Hono<AppEnv>();

// Global error handler — never leak stack traces
app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json({ error: "internal server error" }, 500);
});

// Request timing — log method, path, status, duration for any request that
// took ≥ 100ms. Quieter than logging everything, surfaces real bottlenecks.
app.use("*", async (c, next) => {
	const t0 = Date.now();
	await next();
	const ms = Date.now() - t0;
	if (ms >= 100) {
		console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
	}
});

// Session middleware on all routes
app.use("*", sessionMiddleware(config.sessionSecret));

// Health check (no auth) — returns JSON with system status when ?detail=1
app.get("/health", async (c) => {
	if (!c.req.query("detail")) return c.text("ok");
	const t0 = Date.now();
	let dbOk = false;
	let dbLatencyMs = -1;
	let focusPlacesCount: number | null = null;
	let osmCacheCount: number | null = null;
	let lastSyncDate: string | null = null;
	try {
		await withConnection(async (conn) => {
			const fp = (await conn.query("SELECT COUNT(*) AS n FROM focus_places")) as Array<{ n: number }>;
			focusPlacesCount = Number(fp[0]?.n ?? 0);
			const oc = (await conn.query("SELECT COUNT(*) AS n FROM osm_cache")) as Array<{ n: number }>;
			osmCacheCount = Number(oc[0]?.n ?? 0);
			const ss = (await conn.query(
				"SELECT value FROM sync_state WHERE key_name = 'last_sync_date' ORDER BY updated_at DESC LIMIT 1",
			)) as Array<{ value: string }>;
			lastSyncDate = ss[0]?.value ?? null;
		});
		dbLatencyMs = Date.now() - t0;
		dbOk = true;
	} catch (e) {
		console.error("/health detail failed:", e);
	}
	return c.json({
		ok: dbOk,
		dbLatencyMs,
		focusPlacesCount,
		osmCacheCount,
		lastSyncDate,
		uptimeSec: Math.round(process.uptime()),
	});
});

// OAuth routes
app.route("/", nextcloudOAuthRoutes(config));
app.route("/", fitbitOAuthRoutes(config));

// API routes (all require auth)
app.route("/api", apiRoutes(config));

// Static files (Angular SPA)
app.use("/*", serveStatic({ root: "./public" }));

// Fallback: if no Angular build exists, show a simple landing page
app.get("*", (c) => {
	const session = c.get("session");
	if (!session) {
		return c.html('<h1>Health Dashboard</h1><p><a href="/login">Sign in with Nextcloud</a></p>');
	}
	return c.html(`<h1>Health Dashboard</h1>
    <p>Logged in as ${session.displayName}</p>
    <p><a href="/fitbit/auth">Link Fitbit account</a></p>
    <p><a href="/api/activity">Activity API</a> · <a href="/api/sleep">Sleep API</a> · <a href="/api/devices">Devices API</a></p>
    <form method="POST" action="/logout"><button>Logout</button></form>`);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`Health server listening on port ${info.port}`);
});
