/**
 * Backfill helpers for per-day intraday sync streams.
 *
 * Each Fitbit intraday data type (HR, steps, future: HRV, …) tracks its
 * own historical coverage independently. A stream is a small descriptor
 * that names the data type, knows how to fetch one day, optionally knows
 * how to skip days quickly, and an orchestrator (`sync.ts`) walks the
 * stream backwards day-by-day, persisting per-stream cursor and
 * completion state in `sync_state`.
 *
 * Why per-stream and not one shared cursor:
 *   - Adding a new stream (today: steps; tomorrow: HRV intraday) doesn't
 *     require rewinding everything else.
 *   - Each stream may have a different historical depth — Fitbit kept
 *     HR longer than steps for some users.
 *   - Completion is well-defined per type: HR-empty for 14 days doesn't
 *     mean steps are done, and vice versa.
 *
 * The two helpers below are the *day-level* primitives. The stream-level
 * orchestration (cursor, empty-day streak, completion flag) lives in
 * `sync.ts` because it needs the runtime FitbitClient + DB connection.
 *
 * Day-level: distinguish three outcomes:
 *   - "ok, this day really has no data" → advance the empty-day streak;
 *     after enough consecutive empty days the stream is marked complete.
 *   - "ok, this day has N>0 data points" → reset the streak.
 *   - "the call threw" → do NOT advance the streak. A transient Fitbit
 *     5xx, network blip, or auth-refresh hiccup is a retry opportunity,
 *     not evidence that the day is empty. Conflating the two used to
 *     silently truncate history after 14 consecutive failures.
 */

export type BackfillDayResult = { ok: true; points: number } | { ok: false; error: unknown };

/**
 * Function shape for a single-day intraday sync. Whatever the caller binds
 * here (typically `syncHeartRateIntraday(client, conn, userId, d, d)` or
 * `syncStepsIntraday(client, conn, userId, d, d)`) must resolve to the
 * number of points written, or throw on transient failure.
 */
export type DaySyncFn = (date: string) => Promise<number>;

export async function backfillStreamDay(syncFn: DaySyncFn, date: string): Promise<BackfillDayResult> {
	try {
		const points = await syncFn(date);
		return { ok: true, points };
	} catch (error) {
		return { ok: false, error };
	}
}

export function shouldAdvanceEmptyStreak(result: BackfillDayResult): boolean {
	return result.ok && result.points === 0;
}

/**
 * Descriptor for a per-day backfillable stream. The orchestrator iterates
 * backwards from the stream's stored cursor, calling `sync(date)` on each
 * day (unless `skipIf` returns true) and using `shouldAdvanceEmptyStreak`
 * + `maxEmptyDays` to decide when the stream is complete.
 */
export interface IntradayStream {
	/** Stable name used for sync_state keys: `backfill_${name}_cursor` etc. */
	name: string;
	/** Fetch one day. Throws on transient failure (treated as "retry next time"). */
	sync: DaySyncFn;
	/** Optional: return true to skip this date without spending an API call.
	 *  Use this when another stream'\''s stored data implies this date is empty
	 *  (e.g. steps skips a date with no HR row → Fitbit was off that day). */
	skipIf?: (date: string) => Promise<boolean>;
	/** Consecutive empty days that mark the stream complete. Default 14. */
	maxEmptyDays?: number;
}
