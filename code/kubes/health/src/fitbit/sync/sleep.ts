import type * as mariadb from "mariadb";
import type { FitbitSleepLogId } from "../../db/branded.js";
import { NULL_TZ_SOURCE, type TzSource } from "../../geo/fitbit-tz.js";
import type { FitbitClient } from "../client.js";

export interface FitbitSleepLog {
	/** Fitbit's 64-bit sleep log id. Parsed as a branded bigint by
	 *  the Fitbit client's BigInt-aware JSON parser (see
	 *  parseFitbitJson) so values > 2^53 don't get rounded *and*
	 *  the brand prevents Number coercion downstream. */
	logId: FitbitSleepLogId;
	dateOfSleep: string;
	startTime: string;
	endTime: string;
	duration: number;
	efficiency: number;
	minutesAsleep: number;
	minutesAwake: number;
	isMainSleep: boolean;
	levels?: {
		summary: {
			deep?: { minutes: number };
			light?: { minutes: number };
			rem?: { minutes: number };
			wake?: { minutes: number };
		};
		data: Array<{ dateTime: string; level: string; seconds: number }>;
	};
}

interface SleepResponse {
	sleep: FitbitSleepLog[];
}

/**
 * Pure parser: turn a Fitbit sleep log into the value tuple for the
 * `INSERT INTO sleep` statement, including the row's tz.
 *
 * The `tz` is derived from the user's TzSource using `dateOfSleep`
 * and the time portion of `startTime`. This matches the per-row tz
 * convention in `docs/design/timezone.md` and the pattern in
 * `parseSleepStages` (line 48 below): the tz a wall-clock was
 * recorded in is what makes the wall-clock interpretable later.
 *
 * Existing consumers that read `start_time`/`end_time` as local
 * DATETIMEs continue to work — those fields are passed through
 * unchanged. Tz-aware consumers can convert when they need a UTC
 * timestamp.
 */
export function parseSleepLog(
	log: FitbitSleepLog,
	userId: string,
	tzSource: TzSource = NULL_TZ_SOURCE,
): [
	string,
	FitbitSleepLogId,
	string,
	string,
	string,
	number,
	number,
	number,
	number,
	number | null,
	number | null,
	number | null,
	number | null,
	boolean,
	string | null,
] {
	// startTime shape: "2026-05-12T00:06:00.000". Same split as
	// parseSleepStages: date | time | (milliseconds dropped).
	const [, startTimeRaw] = log.startTime.split("T");
	const startTimeOnly = (startTimeRaw ?? "").split(".")[0];
	const tz = tzSource.forWallClock(log.dateOfSleep, startTimeOnly);
	return [
		userId,
		log.logId,
		log.dateOfSleep,
		log.startTime,
		log.endTime,
		log.duration,
		log.efficiency,
		log.minutesAsleep,
		log.minutesAwake,
		log.levels?.summary.deep?.minutes ?? null,
		log.levels?.summary.light?.minutes ?? null,
		log.levels?.summary.rem?.minutes ?? null,
		log.levels?.summary.wake?.minutes ?? null,
		log.isMainSleep,
		tz,
	];
}

/**
 * Pure parser: given a sleep log's `levels.data` array, return rows shaped
 * for `conn.batch(INSERT INTO sleep_stages ...)`. The trailing `tz` slot is
 * the IANA tz the stage's wall-clock was recorded in; see TIMEZONE.md.
 *
 * Each Fitbit stage entry has its own `dateTime` (a full ISO-shaped wall-
 * clock string like "2026-05-10T22:48:30.000"), which we split into
 * (date, time) before consulting `tzSource`.
 */
export function parseSleepStages(
	stages: Array<{ dateTime: string; level: string; seconds: number }>,
	userId: string,
	sleepLogId: FitbitSleepLogId,
	tzSource: TzSource = NULL_TZ_SOURCE,
): Array<[string, FitbitSleepLogId, string, string, number, string | null]> {
	return stages.map((stage) => {
		// `dateTime` shape: "2026-05-10T22:48:30.000" (no Z suffix from Fitbit).
		// Split into date + time for the TzSource lookup.
		const [date, timeRaw] = stage.dateTime.split("T");
		const time = (timeRaw ?? "").split(".")[0]; // strip milliseconds
		return [userId, sleepLogId, stage.dateTime, stage.level, stage.seconds, tzSource.forWallClock(date, time)];
	});
}

export async function syncSleep(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
	tzSource: TzSource = NULL_TZ_SOURCE,
): Promise<number> {
	const { sleep } = await client.get<SleepResponse>(`/1.2/user/-/sleep/date/${startDate}/${endDate}.json`);

	for (const log of sleep) {
		await conn.query(
			`INSERT INTO sleep (user_id, log_id, date, start_time, end_time, duration_ms, efficiency,
         minutes_asleep, minutes_awake, minutes_deep, minutes_light, minutes_rem, minutes_wake,
         is_main_sleep, tz)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE start_time=VALUES(start_time), end_time=VALUES(end_time),
         duration_ms=VALUES(duration_ms), efficiency=VALUES(efficiency),
         minutes_asleep=VALUES(minutes_asleep), minutes_awake=VALUES(minutes_awake),
         minutes_deep=VALUES(minutes_deep), minutes_light=VALUES(minutes_light),
         minutes_rem=VALUES(minutes_rem), minutes_wake=VALUES(minutes_wake),
         is_main_sleep=VALUES(is_main_sleep), tz=COALESCE(tz, VALUES(tz))`,
			parseSleepLog(log, userId, tzSource),
		);

		if (log.levels?.data && log.levels.data.length > 0) {
			const rows = parseSleepStages(log.levels.data, userId, log.logId, tzSource);
			await conn.batch(
				// COALESCE-preserve `tz` so backfill CLI can later upgrade NULL.
				`INSERT INTO sleep_stages (user_id, sleep_log_id, ts, stage, duration_seconds, tz)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           stage = VALUES(stage),
           duration_seconds = VALUES(duration_seconds),
           tz = COALESCE(tz, VALUES(tz))`,
				rows,
			);
		}
	}

	console.log(`[${userId}] Synced ${sleep.length} sleep logs`);
	return sleep.length;
}
