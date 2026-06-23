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

// JSON API: token-gated /api/ingest, public /api/latest + /api/measurements.
app.route("/api", apiRoutes(config.ingestToken));

// Built Angular app, with SPA fallback to index.html for client-side routes.
app.use("/*", serveStatic({ root: "./public" }));
app.get("/*", serveStatic({ path: "./public/index.html" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
	console.log(`home-env listening on :${info.port}`);
});
