import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

export interface StepsApiResponse {
	"activities-steps": Array<{ dateTime: string; value: string }>;
	"activities-steps-intraday"?: { dataset: Array<{ time: string; value: number }> };
}

/**
 * Pure parser: take a Fitbit intraday-steps response, return the rows we'd
 * insert. We deliberately drop zero-step minutes — most minutes of a typical
 * day are zero, so storing them costs ~5x rows for no information gain
 * (absence implies zero).
 *
 * Returns tuples shaped for `conn.batch(INSERT INTO steps_intraday ...)` so
 * the caller doesn't have to massage the shape.
 */
export function parseStepsDataset(
	response: StepsApiResponse,
	userId: string,
	date: string,
): Array<[string, string, number]> {
	const dataset = response["activities-steps-intraday"]?.dataset;
	if (!dataset?.length) return [];
	const rows: Array<[string, string, number]> = [];
	for (const d of dataset) {
		if (d.value <= 0) continue;
		rows.push([userId, `${date} ${d.time}`, d.value]);
	}
	return rows;
}

/**
 * Sync intraday steps for a date range. Mirrors `syncHeartRateIntraday` —
 * one Fitbit call per day, day-by-day, respects rate limit. Returns the
 * total number of stored points across the range.
 */
export async function syncStepsIntraday(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	let totalSynced = 0;

	for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
		if (client.rateLimitRemaining <= 10) {
			console.log(`[${userId}] Steps intraday paused, rate limit low`);
			break;
		}

		const date = d.toISOString().slice(0, 10);
		const data = await client.get<StepsApiResponse>(`/1/user/-/activities/steps/date/${date}/1d/1min.json`);
		const rows = parseStepsDataset(data, userId, date);
		if (rows.length === 0) continue;

		await conn.batch(
			// MAX-preserve: a later sync that returns a smaller count for a
			// minute we already have data for must not overwrite. Fitbit'\''s
			// intraday endpoint occasionally returns a less-complete response
			// (watch-to-cloud sync timing, server-side aggregation tweaks) and
			// we previously lost real step counts to those replays.
			`INSERT INTO steps_intraday (user_id, ts, steps) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE steps=GREATEST(steps, VALUES(steps))`,
			rows,
		);

		totalSynced += rows.length;
		console.log(`[${userId}] Synced ${rows.length} steps intraday minutes for ${date}`);
	}

	return totalSynced;
}
