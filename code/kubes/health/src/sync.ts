import { backfillStreamDay, type IntradayStream, shouldAdvanceEmptyStreak } from "./backfill.js";
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
import { syncStepsIntraday } from "./fitbit/sync/steps.js";
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

/** One-time, idempotent: migrate the pre-2026-05-10 single-stream
 *  backfill keys (`backfill_cursor`, `backfill_complete`) into the
 *  per-stream namespace under the `hr_intraday` stream — that's what
 *  the legacy keys actually drove. Steps and future streams start
 *  fresh under their own keys. */
async function migrateLegacyBackfillKeys(userId: string): Promise<void> {
	const legacyCursor = await getSyncState(userId, "backfill_cursor");
	const legacyComplete = await getSyncState(userId, "backfill_complete");
	if (legacyCursor !== null) {
		const newCursor = await getSyncState(userId, "backfill_hr_intraday_cursor");
		if (newCursor === null) {
			await setSyncState(userId, "backfill_hr_intraday_cursor", legacyCursor);
		}
	}
	if (legacyComplete !== null) {
		const newComplete = await getSyncState(userId, "backfill_hr_intraday_complete");
		if (newComplete === null) {
			await setSyncState(userId, "backfill_hr_intraday_complete", legacyComplete);
		}
	}
}

/** Walk one stream backwards from its stored cursor, fetching one day per
 *  iteration, until the rate-limit budget is gone or we hit the empty-day
 *  threshold (stream complete). Each stream is independent — HR'\''s
 *  cursor + complete flag are unrelated to Steps'\''s, and so on. */
async function runIntradayBackfill(
	client: FitbitClient,
	userId: string,
	stream: IntradayStream,
	defaultStartDate: string,
): Promise<void> {
	const completeKey = `backfill_${stream.name}_complete`;
	const cursorKey = `backfill_${stream.name}_cursor`;
	const maxEmpty = stream.maxEmptyDays ?? 14;

	if ((await getSyncState(userId, completeKey)) === "true") {
		console.log(`[${userId}] ${stream.name}: backfill already complete`);
		return;
	}
	if (client.rateLimitRemaining <= 15) {
		console.log(`[${userId}] ${stream.name}: rate limit low (${client.rateLimitRemaining}), skipping`);
		return;
	}

	const cursor = (await getSyncState(userId, cursorKey)) ?? defaultStartDate;
	console.log(`[${userId}] ${stream.name}: backfill from ${cursor} going backwards...`);

	let currentDate = prevDay(cursor);
	let emptyStreak = 0;

	while (client.rateLimitRemaining > 15 && emptyStreak < maxEmpty) {
		// skipIf: bypass days that another stream'\''s data tells us are empty.
		// Cheap DB lookup, no API call, no streak advance — just move past.
		if (stream.skipIf && (await stream.skipIf(currentDate))) {
			await setSyncState(userId, cursorKey, currentDate);
			currentDate = prevDay(currentDate);
			continue;
		}

		const result = await backfillStreamDay(stream.sync, currentDate);
		if (!result.ok) {
			console.error(`[${userId}] ${stream.name} ${currentDate} failed: ${result.error}`);
		}
		if (shouldAdvanceEmptyStreak(result)) {
			emptyStreak++;
		} else if (result.ok) {
			emptyStreak = 0;
		}
		// !ok: leave emptyStreak unchanged so transient errors don'\''t
		// silently terminate this stream'\''s backfill.

		await setSyncState(userId, cursorKey, currentDate);
		currentDate = prevDay(currentDate);
	}

	if (emptyStreak >= maxEmpty) {
		console.log(`[${userId}] ${stream.name}: backfill complete — ${maxEmpty} consecutive empty days`);
		await setSyncState(userId, completeKey, "true");
	} else {
		console.log(`[${userId}] ${stream.name}: paused at ${currentDate}. Rate limit: ${client.rateLimitRemaining}`);
	}
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
			await trySync(user.user_id, "steps intraday", () =>
				syncStepsIntraday(client, conn, user.user_id, lastSyncDate, today),
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
		// Each intraday stream tracks its own cursor + complete flag. New
		// streams (e.g. steps added 2026-05-10) start fresh from today and
		// walk back independently; previously-complete streams stay complete.
		await migrateLegacyBackfillKeys(user.user_id);

		await withConnection(async (conn) => {
			const hrStream: IntradayStream = {
				name: "hr_intraday",
				sync: async (date: string) => {
					const points = await syncHeartRateIntraday(client, conn, user.user_id, date, date);
					// Daily summaries ride along on HR'\''s coverage. Their per-day
					// fetch is cheap and they only have meaningful empty/non-empty
					// at the daily level, which HR'\''s streak already captures.
					await trySync(user.user_id, `backfill activity ${date}`, () =>
						syncActivity(client, conn, user.user_id, date, date),
					);
					await trySync(user.user_id, `backfill sleep ${date}`, () =>
						syncSleep(client, conn, user.user_id, date, date),
					);
					return points;
				},
			};

			const stepsStream: IntradayStream = {
				name: "steps_intraday",
				sync: (date: string) => syncStepsIntraday(client, conn, user.user_id, date, date),
				// Skip days where we already know Fitbit was off (no HR row stored).
				// Saves rate limit; data integrity is preserved because if HR ever
				// gets backfilled later, we'\''ll re-evaluate (skipIf is checked each run).
				skipIf: async (date: string) => {
					const start = `${date} 00:00:00`;
					const end = `${date} 23:59:59`;
					const row = await db()
						.selectFrom("heart_rate_intraday")
						.select("ts")
						.where("user_id", "=", user.user_id)
						.where("ts", ">=", start)
						.where("ts", "<=", end)
						.limit(1)
						.executeTakeFirst();
					return !row;
				},
			};

			for (const stream of [hrStream, stepsStream]) {
				await runIntradayBackfill(client, user.user_id, stream, lastSyncDate);
			}
		});

		console.log(`[${user.user_id}] Done. Rate limit remaining: ${client.rateLimitRemaining}`);
	} catch (e) {
		console.error(`[${user.user_id}] Sync failed:`, e);
	}
}

await destroyPool();
