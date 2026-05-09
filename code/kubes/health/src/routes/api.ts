import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import type { Config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/pool.js";
import { NextcloudClient } from "../nextcloud/client.js";

const daysParam = z.coerce.number().int().min(1).max(365).default(30);
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(
  () => new Date().toISOString().slice(0, 10)
);

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

export function apiRoutes(config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("/*", requireAuth);

  app.get("/me", async (c) => {
    const { userId, displayName } = c.get("session");
    const row = await db()
      .selectFrom("tokens")
      .select("user_id")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return c.json({ userId, displayName, fitbitLinked: !!row });
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
    const rows = await db()
      .selectFrom("devices")
      .selectAll()
      .where("user_id", "=", uid)
      .execute();
    return c.json(rows);
  });

  app.get("/locations", async (c) => {
    const uid = c.get("session").userId;
    const date = dateParam.parse(c.req.query("date"));

    // Get user's Nextcloud token
    const ncToken = await db()
      .selectFrom("nc_tokens")
      .select(["access_token", "refresh_token", "expires_at"])
      .where("user_id", "=", uid)
      .executeTakeFirst();

    if (!ncToken) {
      return c.json({ error: "Nextcloud not linked. Log in again to grant access." }, 400);
    }

    const nc = new NextcloudClient({
      accessToken: ncToken.access_token,
      refreshToken: ncToken.refresh_token,
      expiresAt: new Date(ncToken.expires_at).getTime(),
      baseUrl: config.nextcloud.baseUrl,
      clientId: config.nextcloud.clientId,
      clientSecret: config.nextcloud.clientSecret,
      onTokenRefresh: async (accessToken, refreshToken, expiresIn) => {
        await db()
          .updateTable("nc_tokens")
          .set({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: new Date(Date.now() + expiresIn * 1000),
          })
          .where("user_id", "=", uid)
          .execute();
      },
    });

    // Get all sessions, then fetch points for the requested date
    const sessions = await nc.get<Record<string, { id: number; name: string; devices?: Record<string, { id: number; name: string }> }>>(
      "/index.php/apps/phonetrack/sessions"
    );

    const minTs = Math.floor(new Date(date).getTime() / 1000);
    const maxTs = Math.floor(new Date(nextDay(date)).getTime() / 1000);
    const allPoints: Array<{ ts: number; lat: number; lon: number; altitude: number | null; speed: number | null; accuracy: number | null; battery: number | null }> = [];

    for (const session of Object.values(sessions)) {
      if (!session.devices) continue;
      for (const device of Object.values(session.devices)) {
        try {
          const points = await nc.get<Array<{ timestamp: number; lat: number; lon: number; altitude: number | null; speed: number | null; accuracy: number | null; batterylevel: number | null }>>(
            `/index.php/apps/phonetrack/session/${session.id}/device/${device.id}/points?minTimestamp=${minTs}&maxTimestamp=${maxTs}&maxPoints=10000`
          );
          if (Array.isArray(points)) {
            for (const p of points) {
              allPoints.push({
                ts: p.timestamp,
                lat: p.lat,
                lon: p.lon,
                altitude: p.altitude,
                speed: p.speed,
                accuracy: p.accuracy,
                battery: p.batterylevel,
              });
            }
          }
        } catch {
          // skip devices that fail
        }
      }
    }

    allPoints.sort((a, b) => a.ts - b.ts);
    return c.json(allPoints);
  });

  app.get("/sync-state", async (c) => {
    const uid = c.get("session").userId;
    const rows = await db()
      .selectFrom("sync_state")
      .selectAll()
      .where("user_id", "=", uid)
      .execute();
    return c.json(rows);
  });

  return app;
}
