import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

interface HRResponse {
	"activities-heart": Array<{
		dateTime: string;
		value: { heartRateZones: Array<{ name: string; min: number; max: number; minutes: number; caloriesOut: number }> };
	}>;
	"activities-heart-intraday"?: { dataset: Array<{ time: string; value: number }> };
}

export async function syncHeartRateZones(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	const data = await client.get<HRResponse>(`/1/user/-/activities/heart/date/${startDate}/${endDate}.json`);
	let synced = 0;

	for (const day of data["activities-heart"]) {
		for (const z of day.value.heartRateZones) {
			await conn.query(
				`INSERT INTO heart_rate_zones (user_id, date, zone_name, minutes, calories, min_bpm, max_bpm)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
         minutes=VALUES(minutes), calories=VALUES(calories), min_bpm=VALUES(min_bpm), max_bpm=VALUES(max_bpm)`,
				[userId, day.dateTime, z.name, z.minutes, z.caloriesOut, z.min, z.max],
			);
		}
		synced++;
	}

	console.log(`[${userId}] Synced ${synced} days of HR zones`);
	return synced;
}

/**
 * Sync intraday heart rate for a date range.
 * The Fitbit API only allows 24h per request, so this loops day-by-day.
 * Respects rate limits — stops if remaining calls drop below 10.
 */
export async function syncHeartRateIntraday(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	let totalSynced = 0;

	for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
		if (client.rateLimitRemaining <= 10) {
			console.log(`[${userId}] HR intraday paused, rate limit low`);
			break;
		}

		const date = d.toISOString().slice(0, 10);
		const data = await client.get<HRResponse>(`/1/user/-/activities/heart/date/${date}/1d/1sec.json`);
		const dataset = data["activities-heart-intraday"]?.dataset;
		if (!dataset?.length) continue;

		await conn.batch(
			`INSERT INTO heart_rate_intraday (user_id, ts, bpm) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE bpm=VALUES(bpm)`,
			dataset.map((d) => [userId, `${date} ${d.time}`, d.value]),
		);

		totalSynced += dataset.length;
		console.log(`[${userId}] Synced ${dataset.length} HR intraday points for ${date}`);
	}

	return totalSynced;
}
