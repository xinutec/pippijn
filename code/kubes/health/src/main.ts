import { connect } from "./db/connection.js";
import { migrate } from "./db/schema.js";
import { FitbitClient } from "./fitbit/client.js";
import type { TokenPair } from "./fitbit/types.js";
import { syncActivity } from "./sync/activity.js";
import { syncSleep } from "./sync/sleep.js";
import { syncHeartRateZones, syncHeartRateIntraday } from "./sync/heartrate.js";
import { syncBody } from "./sync/body.js";
import { syncSpO2Daily } from "./sync/spo2.js";
import { syncHrv } from "./sync/hrv.js";
import { syncBreathingRate } from "./sync/breathing.js";
import { syncTemperature } from "./sync/temperature.js";
import { syncDevices } from "./sync/devices.js";

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

async function syncUser(
  db: Awaited<ReturnType<typeof connect>>,
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: Date
): Promise<void> {
  console.log(`\n=== Syncing user: ${userId} ===`);

  const client = new FitbitClient({
    accessToken,
    refreshToken,
    expiresAt: expiresAt.getTime(),
    clientId: process.env.FITBIT_CLIENT_ID ?? "",
    clientSecret: process.env.FITBIT_CLIENT_SECRET ?? "",
    onTokenRefresh: async (tokens: TokenPair) => {
      await db.query(
        `UPDATE tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE user_id = ?`,
        [tokens.access_token, tokens.refresh_token,
         new Date(Date.now() + tokens.expires_in * 1000), userId]
      );
      console.log(`[${userId}] Tokens refreshed`);
    },
  });

  const lastSyncRow = await db.query(
    "SELECT value FROM sync_state WHERE user_id = ? AND key_name = 'last_sync_date'",
    [userId]
  );

  const lastSyncDate = lastSyncRow.length > 0 ? lastSyncRow[0].value : daysAgo(30);
  const today = formatDate(new Date());
  const yesterday = daysAgo(1);

  console.log(`[${userId}] Sync window: ${lastSyncDate} to ${today}`);

  await syncDevices(client, db, userId);
  await syncActivity(client, db, userId, lastSyncDate, today);
  await syncSleep(client, db, userId, lastSyncDate, today);
  await syncHeartRateZones(client, db, userId, lastSyncDate, today);
  await syncBody(client, db, userId, lastSyncDate, today);

  if (client.rateLimitRemaining > 20) {
    await syncHeartRateIntraday(client, db, userId, yesterday);
  }

  const optional = [
    () => syncSpO2Daily(client, db, userId, lastSyncDate, today),
    () => syncHrv(client, db, userId, lastSyncDate, today),
    () => syncBreathingRate(client, db, userId, lastSyncDate, today),
    () => syncTemperature(client, db, userId, lastSyncDate, today),
  ];

  for (const fn of optional) {
    try { await fn(); }
    catch (e) { console.log(`[${userId}] Optional sync skipped: ${e}`); }
  }

  await db.query(
    `INSERT INTO sync_state (user_id, key_name, value)
     VALUES (?, 'last_sync_date', ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [userId, today]
  );

  console.log(`[${userId}] Sync complete. Rate limit remaining: ${client.rateLimitRemaining}`);
}

async function main(): Promise<void> {
  const db = await connect();

  try {
    await migrate(db);

    const users = await db.query(
      "SELECT user_id, access_token, refresh_token, expires_at FROM tokens"
    );

    if (users.length === 0) {
      console.log("No users with Fitbit tokens. Each user must authorize via /fitbit/auth first.");
      return;
    }

    console.log(`Found ${users.length} user(s) with Fitbit tokens`);

    for (const user of users) {
      try {
        await syncUser(db, user.user_id, user.access_token, user.refresh_token, user.expires_at);
      } catch (e) {
        console.error(`[${user.user_id}] Sync failed:`, e);
      }
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
