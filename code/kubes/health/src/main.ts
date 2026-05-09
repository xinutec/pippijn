import { connect, getDbConfig } from "./db/connection.js";
import { migrate } from "./db/schema.js";
import { FitbitClient } from "./fitbit/client.js";
import type { TokenPair } from "./fitbit/types.js";
import { syncActivity } from "./sync/activity.js";
import { syncSleep } from "./sync/sleep.js";
import {
  syncHeartRateZones,
  syncHeartRateIntraday,
} from "./sync/heartrate.js";
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

async function main(): Promise<void> {
  const db = await connect();

  try {
    await migrate(db);

    // Load tokens from DB
    const tokenRow = await db.query(
      "SELECT access_token, refresh_token, expires_at FROM tokens WHERE id = 1"
    );

    if (!tokenRow || tokenRow.length === 0) {
      console.error(
        "No tokens found in database. Run the auth flow first: node dist/auth.js"
      );
      process.exit(1);
    }

    const { access_token, refresh_token, expires_at } = tokenRow[0];

    const client = new FitbitClient({
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: new Date(expires_at).getTime(),
      clientId: process.env.FITBIT_CLIENT_ID ?? "",
      clientSecret: process.env.FITBIT_CLIENT_SECRET ?? "",
      onTokenRefresh: async (tokens: TokenPair) => {
        await db.query(
          `UPDATE tokens SET
            access_token = ?,
            refresh_token = ?,
            expires_at = ?
          WHERE id = 1`,
          [
            tokens.access_token,
            tokens.refresh_token,
            new Date(Date.now() + tokens.expires_in * 1000),
          ]
        );
        console.log("Tokens refreshed and saved to DB");
      },
    });

    // Determine sync window
    const lastSyncRow = await db.query(
      "SELECT value FROM sync_state WHERE key_name = 'last_sync_date'"
    );

    const lastSyncDate =
      lastSyncRow.length > 0 ? lastSyncRow[0].value : daysAgo(30);
    const today = formatDate(new Date());
    const yesterday = daysAgo(1);

    console.log(`Sync window: ${lastSyncDate} to ${today}`);

    // Sync each data type
    await syncDevices(client, db);
    await syncActivity(client, db, lastSyncDate, today);
    await syncSleep(client, db, lastSyncDate, today);
    await syncHeartRateZones(client, db, lastSyncDate, today);
    await syncBody(client, db, lastSyncDate, today);

    // Intraday data: only yesterday (most recent complete day)
    if (client.rateLimitRemaining > 20) {
      await syncHeartRateIntraday(client, db, yesterday);
    }

    // These endpoints may not be available on all devices
    try {
      await syncSpO2Daily(client, db, lastSyncDate, today);
    } catch (e) {
      console.log(`SpO2 sync skipped: ${e}`);
    }

    try {
      await syncHrv(client, db, lastSyncDate, today);
    } catch (e) {
      console.log(`HRV sync skipped: ${e}`);
    }

    try {
      await syncBreathingRate(client, db, lastSyncDate, today);
    } catch (e) {
      console.log(`Breathing rate sync skipped: ${e}`);
    }

    try {
      await syncTemperature(client, db, lastSyncDate, today);
    } catch (e) {
      console.log(`Temperature sync skipped: ${e}`);
    }

    // Update last sync date
    await db.query(
      `INSERT INTO sync_state (key_name, value)
       VALUES ('last_sync_date', ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [today]
    );

    console.log(
      `Sync complete. Rate limit remaining: ${client.rateLimitRemaining}`
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
