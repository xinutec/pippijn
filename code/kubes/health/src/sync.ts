import { loadSyncConfig } from "./config.js";
import { db, destroyPool, initPool, withConnection } from "./db/pool.js";
import { migrate } from "./db/schema.js";
import { FitbitClient } from "./fitbit/client.js";
import { syncActivity } from "./fitbit/sync/activity.js";
import { syncBody } from "./fitbit/sync/body.js";
import { syncBreathingRate } from "./fitbit/sync/breathing.js";
import { syncDevices } from "./fitbit/sync/devices.js";
import { syncHeartRateIntraday, syncHeartRateZones } from "./fitbit/sync/heartrate.js";
import { syncHrv } from "./fitbit/sync/hrv.js";
import { syncSleep } from "./fitbit/sync/sleep.js";
import { syncSpO2Daily } from "./fitbit/sync/spo2.js";
import { syncTemperature } from "./fitbit/sync/temperature.js";
import type { FitbitTokenPair } from "./types.js";

function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return formatDate(d);
}

const config = loadSyncConfig();
initPool(config.db);

await withConnection(migrate);

const users = await db()
	.selectFrom("tokens")
	.select(["user_id", "access_token", "refresh_token", "expires_at"])
	.execute();

if (users.length === 0) {
	console.log("No users with Fitbit tokens. Each user must authorize via /fitbit/auth first.");
	await destroyPool();
	process.exit(0);
}

console.log(`Found ${users.length} user(s) with Fitbit tokens`);

for (const user of users) {
	try {
		console.log(`\n=== Syncing: ${user.user_id} ===`);

		const client = new FitbitClient({
			accessToken: user.access_token,
			refreshToken: user.refresh_token,
			expiresAt: new Date(user.expires_at).getTime(),
			clientId: config.fitbit.clientId,
			clientSecret: config.fitbit.clientSecret,
			onTokenRefresh: async (tokens: FitbitTokenPair) => {
				await db()
					.updateTable("tokens")
					.set({
						access_token: tokens.access_token,
						refresh_token: tokens.refresh_token,
						expires_at: new Date(Date.now() + tokens.expires_in * 1000),
					})
					.where("user_id", "=", user.user_id)
					.execute();
				console.log(`[${user.user_id}] Tokens refreshed`);
			},
		});

		const lastSyncRow = await db()
			.selectFrom("sync_state")
			.select("value")
			.where("user_id", "=", user.user_id)
			.where("key_name", "=", "last_sync_date")
			.executeTakeFirst();

		const lastSyncDate = lastSyncRow?.value ?? daysAgo(30);
		const today = formatDate(new Date());
		const yesterday = daysAgo(1);

		console.log(`[${user.user_id}] Sync window: ${lastSyncDate} → ${today}`);

		// Each data type syncs independently — one failure doesn't block the rest
		await withConnection(async (conn) => {
			const trySync = async (name: string, fn: () => Promise<unknown>) => {
				try {
					await fn();
				} catch (e) {
					console.error(`[${user.user_id}] ${name} sync failed: ${e}`);
				}
			};

			await trySync("devices", () => syncDevices(client, conn, user.user_id));
			await trySync("activity", () => syncActivity(client, conn, user.user_id, lastSyncDate, today));
			await trySync("sleep", () => syncSleep(client, conn, user.user_id, lastSyncDate, today));
			await trySync("HR zones", () => syncHeartRateZones(client, conn, user.user_id, lastSyncDate, today));
			await trySync("body", () => syncBody(client, conn, user.user_id, lastSyncDate, today));

			// Fetch intraday HR for each day in the sync window (API allows max 24h per request)
			if (client.rateLimitRemaining > 20) {
				for (let d = new Date(lastSyncDate); d <= new Date(today); d.setDate(d.getDate() + 1)) {
					if (client.rateLimitRemaining <= 10) break;
					const dateStr = d.toISOString().slice(0, 10);
					await trySync(`HR intraday ${dateStr}`, () => syncHeartRateIntraday(client, conn, user.user_id, dateStr));
				}
			}

			await trySync("SpO2", () => syncSpO2Daily(client, conn, user.user_id, lastSyncDate, today));
			await trySync("HRV", () => syncHrv(client, conn, user.user_id, lastSyncDate, today));
			await trySync("breathing", () => syncBreathingRate(client, conn, user.user_id, lastSyncDate, today));
			await trySync("temperature", () => syncTemperature(client, conn, user.user_id, lastSyncDate, today));
		});

		// Update sync state via Kysely
		await db()
			.insertInto("sync_state")
			.values({ user_id: user.user_id, key_name: "last_sync_date", value: today })
			.onDuplicateKeyUpdate({ value: today })
			.execute();

		console.log(`[${user.user_id}] Done. Rate limit remaining: ${client.rateLimitRemaining}`);
	} catch (e) {
		console.error(`[${user.user_id}] Sync failed:`, e);
	}
}

await destroyPool();
