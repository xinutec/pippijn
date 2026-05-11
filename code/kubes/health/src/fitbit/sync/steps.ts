import type * as mariadb from "mariadb";
import { NULL_TZ_SOURCE, type TzSource } from "../../geo/fitbit-tz.js";
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
 * the caller doesn't have to massage the shape. The trailing `tz` slot is
 * the IANA tz the wall-clock was recorded in; see TIMEZONE.md.
 */
export function parseStepsDataset(
	response: StepsApiResponse,
	userId: string,
	date: string,
	tzSource: TzSource = NULL_TZ_SOURCE,
): Array<[string, string, number, string | null]> {
	const dataset = response["activities-steps-intraday"]?.dataset;
	if (!dataset?.length) return [];
	const rows: Array<[string, string, number, string | null]> = [];
	for (const d of dataset) {
		if (d.value <= 0) continue;
		rows.push([userId, `${date} ${d.time}`, d.value, tzSource.forWallClock(date, d.time)]);
	}
	return rows;
}

/**
 * Sync intraday steps for a date range. Mirrors `syncHeartRateIntraday` —
 * one Fitbit call per day, day-by-day, respects rate limit. Returns the
 * total number of stored points across the range.
 *
 * Forward sync passes a real `tzSource` derived from PhoneTrack + profile.tz.
 * Backward backfill leaves it at default (NULL_TZ_SOURCE), which writes
 * `tz=NULL` rows for the Phase 3 backfill CLI to fill in later.
 */
export async function syncStepsIntraday(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
	tzSource: TzSource = NULL_TZ_SOURCE,
): Promise<number> {
	let totalSynced = 0;

	for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
		if (client.rateLimitRemaining <= 10) {
			console.log(`[${userId}] Steps intraday paused, rate limit low`);
			break;
		}

		const date = d.toISOString().slice(0, 10);
		const data = await client.get<StepsApiResponse>(`/1/user/-/activities/steps/date/${date}/1d/1min.json`);
		const rows = parseStepsDataset(data, userId, date, tzSource);
		if (rows.length === 0) continue;

		await conn.batch(
			// MAX-preserve `steps` (a later sync returning a smaller count for a
			// minute we already have data for must not overwrite — Fitbit's
			// intraday endpoint occasionally serves a less-complete response).
			// COALESCE-preserve `tz` (the first non-NULL sticks; the backfill
			// CLI bypasses this to write tz directly).
			`INSERT INTO steps_intraday (user_id, ts, steps, tz) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         steps = GREATEST(steps, VALUES(steps)),
         tz    = COALESCE(tz, VALUES(tz))`,
			rows,
		);

		totalSynced += rows.length;
		console.log(`[${userId}] Synced ${rows.length} steps intraday minutes for ${date}`);
	}

	return totalSynced;
}
