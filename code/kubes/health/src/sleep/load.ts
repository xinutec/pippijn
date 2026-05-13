/**
 * Sleep loaders for the DayState pipeline.
 *
 * Two responsibilities:
 *   - `loadDaySleepWindows(userId, date)` — DB-touching query that
 *     fetches the main sleep records bracketing a given day.
 *   - Pure helpers (`derivePlaceForSleep`, `nextDateString`) used
 *     by the loader and by callers to enrich raw windows with a
 *     place from the segments pipeline.
 */

import { db } from "../db/pool.js";
import { fitbitTsToUnix } from "../geo/timezone.js";
import type { EnrichedSegment } from "../geo/velocity.js";
import type { SleepWindow } from "./day-state.js";

/** Next-day calendar date. Uses UTC arithmetic — dates are
 *  calendar concepts, not moment concepts. */
export function nextDateString(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

/** A raw sleep window pulled from the DB before being enriched
 *  with a `place` from the segments pipeline. The shape matches
 *  `SleepWindow` but `place` is omitted — it's derived later. */
export interface RawSleepWindow {
	startTs: number;
	endTs: number;
	tz: string | null;
	minutesAsleep: number;
}

/** Look at segments and return the place a stationary segment is
 *  tagged with, if any such segment overlaps the sleep window.
 *  Returns null when:
 *    - the sleep occurred entirely inside moving segments
 *      (overnight train), or
 *    - no overlapping stationary segment has a place tag.
 *
 *  Why overlap (not just "contains start"): the morning sleep
 *  event's `startTs` lies the previous evening, outside today's
 *  segment range. The wake-up endpoint, however, is inside today's
 *  first stationary segment. Checking overlap covers both directions
 *  (morning sleep from yesterday's bed; evening sleep into
 *  tomorrow's bed) without separate code paths.
 *
 *  Pure function — the segments pipeline produces the candidates;
 *  this helper only consults them. */
export function derivePlaceForSleep(
	window: { startTs: number; endTs: number },
	segments: readonly EnrichedSegment[],
): string | null {
	const overlapping = segments.find(
		(s) =>
			s.endTs > window.startTs &&
			s.startTs < window.endTs &&
			(s.refinedMode ?? s.mode) === "stationary" &&
			s.place !== undefined,
	);
	return overlapping?.place ?? null;
}

/**
 * Fetch the two main sleep records that touch `date` for `userId`:
 *
 *   - The sleep whose `date` column equals `date` — i.e. the
 *     overnight sleep that ENDED on this day. Provides the morning
 *     wake-up event.
 *   - The sleep whose `date` column equals the next day — i.e.
 *     this evening's bedtime, which ends tomorrow. Provides the
 *     evening fall-asleep event.
 *
 *  Returns 0–2 raw windows. The `tz` column populated by Phase 2
 *  of the per-row-tz convention disambiguates the local DATETIME
 *  values into unix seconds.
 */
export async function loadDaySleepWindows(userId: string, date: string): Promise<RawSleepWindow[]> {
	const morning = await db()
		.selectFrom("sleep")
		.select(["start_time", "end_time", "tz", "minutes_asleep"])
		.where("user_id", "=", userId)
		.where("date", "=", date)
		.where("is_main_sleep", "=", true as never)
		.executeTakeFirst();
	const evening = await db()
		.selectFrom("sleep")
		.select(["start_time", "end_time", "tz", "minutes_asleep"])
		.where("user_id", "=", userId)
		.where("date", "=", nextDateString(date))
		.where("is_main_sleep", "=", true as never)
		.executeTakeFirst();

	const out: RawSleepWindow[] = [];
	for (const row of [morning, evening]) {
		if (!row) continue;
		const tz = row.tz;
		out.push({
			startTs: fitbitTsToUnix(row.start_time, tz ?? undefined),
			endTs: fitbitTsToUnix(row.end_time, tz ?? undefined),
			tz,
			minutesAsleep: row.minutes_asleep ?? 0,
		});
	}
	return out;
}

/** Enrich raw sleep windows with `place` from segments and produce
 *  the full `SleepWindow` shape the day-state converter expects. */
export function enrichSleepWindows(
	raw: readonly RawSleepWindow[],
	segments: readonly EnrichedSegment[],
): SleepWindow[] {
	return raw.map((w) => ({
		startTs: w.startTs,
		endTs: w.endTs,
		tz: w.tz,
		minutesAsleep: w.minutesAsleep,
		place: derivePlaceForSleep(w, segments),
	}));
}
