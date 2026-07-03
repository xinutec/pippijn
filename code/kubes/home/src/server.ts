import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { initPool, withConnection } from "./db/pool.js";
import { migrate } from "./db/schema.js";
import { apiRoutes } from "./routes/api.js";

const config = loadConfig();
initPool(config.db);
await withConnection(migrate);

const app = new Hono();

app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json({ error: "internal server error" }, 500);
});

// Liveness/readiness probe (no auth).
app.get("/health", (c) => c.json({ ok: true }));

// JSON API: token-gated /api/ingest, public /api/devices + /api/measurements.
app.route("/api", apiRoutes(config.ingestToken));

// Unknown /api paths are JSON 404s — they must never fall through to the SPA
// fallback, which would answer an API caller with 200 + index.html.
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// SPA caching: HTML must always revalidate so a new deploy is picked up on a
// normal reload; fingerprinted assets are immutable. (API responses untouched.)
app.use("/*", async (c, next) => {
	await next();
	if (c.req.path.startsWith("/api")) return;
	const hashed = /-[A-Za-z0-9]{8,}\.(?:js|css|woff2?)$/.test(c.req.path);
	c.header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
});

// Built Angular app, with SPA fallback to index.html for client-side routes.
app.use("/*", serveStatic({ root: "./public" }));
app.get("/*", serveStatic({ path: "./public/index.html" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`home-env listening on :${info.port}`);
});
