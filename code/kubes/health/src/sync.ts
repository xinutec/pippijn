import { backfillHrForDay, shouldAdvanceEmptyStreak } from "./backfill.js";
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

function prevDay(date: string): string {
	const d = new Date(date);
	d.setDate(d.getDate() - 1);
	return formatDate(d);
}

async function getSyncState(userId: string, key: string): Promise<string | null> {
	const row = await db()
		.selectFrom("sync_state")
		.select("value")
		.where("user_id", "=", userId)
		.where("key_name", "=", key)
		.executeTakeFirst();
	return row?.value ?? null;
}

async function setSyncState(userId: string, key: string, value: string): Promise<void> {
	await db()
		.insertInto("sync_state")
		.values({ user_id: userId, key_name: key, value })
		.onDuplicateKeyUpdate({ value })
		.execute();
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

const trySync = async (userId: string, name: string, fn: () => Promise<unknown>) => {
	try {
		await fn();
	} catch (e) {
		console.error(`[${userId}] ${name} sync failed: ${e}`);
	}
};

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

		// --- Pass 1: Forward sync (new data) ---
		const lastSyncDate = (await getSyncState(user.user_id, "last_sync_date")) ?? daysAgo(30);
		const today = formatDate(new Date());

		console.log(`[${user.user_id}] Forward sync: ${lastSyncDate} → ${today}`);

		await withConnection(async (conn) => {
			await trySync(user.user_id, "devices", () => syncDevices(client, conn, user.user_id));
			await trySync(user.user_id, "activity", () => syncActivity(client, conn, user.user_id, lastSyncDate, today));
			await trySync(user.user_id, "sleep", () => syncSleep(client, conn, user.user_id, lastSyncDate, today));
			await trySync(user.user_id, "HR zones", () =>
				syncHeartRateZones(client, conn, user.user_id, lastSyncDate, today),
			);
			await trySync(user.user_id, "body", () => syncBody(client, conn, user.user_id, lastSyncDate, today));
			await trySync(user.user_id, "HR intraday", () =>
				syncHeartRateIntraday(client, conn, user.user_id, lastSyncDate, today),
			);
			await trySync(user.user_id, "SpO2", () => syncSpO2Daily(client, conn, user.user_id, lastSyncDate, today));
			await trySync(user.user_id, "HRV", () => syncHrv(client, conn, user.user_id, lastSyncDate, today));
			await trySync(user.user_id, "breathing", () =>
				syncBreathingRate(client, conn, user.user_id, lastSyncDate, today),
			);
			await trySync(user.user_id, "temperature", () =>
				syncTemperature(client, conn, user.user_id, lastSyncDate, today),
			);
		});

		await setSyncState(user.user_id, "last_sync_date", today);
		console.log(`[${user.user_id}] Forward sync done. Rate limit: ${client.rateLimitRemaining}`);

		// --- Pass 2: Backward backfill (historical data) ---
		const backfillComplete = (await getSyncState(user.user_id, "backfill_complete")) === "true";

		if (backfillComplete) {
			console.log(`[${user.user_id}] Backfill already complete.`);
		} else if (client.rateLimitRemaining <= 15) {
			console.log(`[${user.user_id}] Skipping backfill, rate limit low (${client.rateLimitRemaining}).`);
		} else {
			const cursor = (await getSyncState(user.user_id, "backfill_cursor")) ?? lastSyncDate;
			console.log(`[${user.user_id}] Backfill from ${cursor} going backwards...`);

			let currentDate = prevDay(cursor);
			let emptyStreak = 0;
			const MAX_EMPTY_DAYS = 14; // stop after 14 consecutive empty days

			await withConnection(async (conn) => {
				while (client.rateLimitRemaining > 15 && emptyStreak < MAX_EMPTY_DAYS) {
					const dateStr = currentDate;

					// Primary high-value backfill target. We must distinguish a
					// genuine empty day (advance streak) from a transient failure
					// (do NOT advance streak — see src/backfill.ts).
					const hrResult = await backfillHrForDay(
						(d) => syncHeartRateIntraday(client, conn, user.user_id, d, d),
						dateStr,
					);
					if (!hrResult.ok) {
						console.error(`[${user.user_id}] backfill HR ${dateStr} failed: ${hrResult.error}`);
					}

					// Also backfill daily summaries for this date
					await trySync(user.user_id, `backfill activity ${dateStr}`, () =>
						syncActivity(client, conn, user.user_id, dateStr, dateStr),
					);
					await trySync(user.user_id, `backfill sleep ${dateStr}`, () =>
						syncSleep(client, conn, user.user_id, dateStr, dateStr),
					);

					if (shouldAdvanceEmptyStreak(hrResult)) {
						emptyStreak++;
					} else if (hrResult.ok) {
						// Successful day with data — reset the streak.
						emptyStreak = 0;
					}
					// !ok: leave emptyStreak unchanged so transient errors don't
					// silently terminate backfill.

					// Save cursor after each day so we don't redo work if interrupted
					await setSyncState(user.user_id, "backfill_cursor", dateStr);

					currentDate = prevDay(currentDate);
				}
			});

			if (emptyStreak >= MAX_EMPTY_DAYS) {
				console.log(`[${user.user_id}] Backfill complete — ${MAX_EMPTY_DAYS} consecutive empty days.`);
				await setSyncState(user.user_id, "backfill_complete", "true");
			} else {
				console.log(`[${user.user_id}] Backfill paused at ${currentDate}. Rate limit: ${client.rateLimitRemaining}`);
			}
		}

		console.log(`[${user.user_id}] Done. Rate limit remaining: ${client.rateLimitRemaining}`);
	} catch (e) {
		console.error(`[${user.user_id}] Sync failed:`, e);
	}
}

await destroyPool();
