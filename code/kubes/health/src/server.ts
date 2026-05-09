import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { initPool, withConnection } from "./db/pool.js";
import { migrate } from "./db/schema.js";
import { sessionMiddleware } from "./middleware/session.js";
import { nextcloudOAuthRoutes } from "./routes/nextcloud-oauth.js";
import { fitbitOAuthRoutes } from "./routes/fitbit-oauth.js";
import { apiRoutes } from "./routes/api.js";

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

// Session middleware on all routes
app.use("*", sessionMiddleware(config.sessionSecret));

// Health check (no auth)
app.get("/health", (c) => c.text("ok"));

// OAuth routes
app.route("/", nextcloudOAuthRoutes(config));
app.route("/", fitbitOAuthRoutes(config));

// API routes (all require auth)
app.route("/api", apiRoutes());

// Static files (Angular SPA)
app.use("/*", serveStatic({ root: "./public" }));

// SPA fallback: serve index.html for unmatched routes
app.get("*", serveStatic({ root: "./public", path: "/index.html" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Health server listening on port ${info.port}`);
});
