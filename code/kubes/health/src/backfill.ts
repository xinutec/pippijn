/**
 * Backfill helpers for the per-day historical-data sync loop in `sync.ts`.
 *
 * The point of these helpers is to draw a clean line between two outcomes
 * the loop must distinguish but used to conflate:
 *   - "ok, this day really has no data" → advance the empty-day streak;
 *     after enough consecutive empty days we mark backfill complete and
 *     stop hammering the Fitbit API.
 *   - "the API call threw" → do NOT advance the streak. A transient
 *     Fitbit 5xx, network blip, or auth-refresh hiccup is a retry
 *     opportunity, not evidence that the day is empty.
 *
 * The previous code stored a default `pointCount = 0` and then ran the
 * sync inside a try/catch that swallowed the exception, so a thrown call
 * looked identical to a genuinely empty day — which silently truncated
 * history after a streak of unrelated failures.
 */

export type BackfillDayResult = { ok: true; points: number } | { ok: false; error: unknown };

/**
 * Function shape for a single-day intraday sync. Whatever the caller binds
 * here (typically `syncHeartRateIntraday(client, conn, userId, d, d)`) must
 * resolve to the number of points written, or throw on transient failure.
 */
export type DaySyncFn = (date: string) => Promise<number>;

export async function backfillHrForDay(syncFn: DaySyncFn, date: string): Promise<BackfillDayResult> {
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
