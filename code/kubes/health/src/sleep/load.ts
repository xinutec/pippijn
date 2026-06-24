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

/** Max time gap (seconds) between a sleep window and the nearest
 *  stationary segment we'll still trust as the sleep location.
 *  Six hours covers the common case where the user wakes at 08:00
 *  but doesn't get a GPS fix until ~midday (phone idle at home):
 *  the noon segment's place is a defensible answer for the sleep.
 *  Beyond six hours, fall through to null — the user may well have
 *  gone somewhere between waking and the next fix, and we don't
 *  want to paint sleep onto an unrelated place. */
const PLACE_FALLBACK_MAX_GAP_SEC = 6 * 3600;

/** A residential place (one the user actually sleeps at) anchors the sleep
 *  label even hours from the window — you slept where you live, regardless
 *  of how much activity happened between waking and getting home. A
 *  non-residential place needs the tighter `PLACE_FALLBACK_MAX_GAP_SEC`
 *  cap so a random daytime stop isn't painted as the night. 12h spans a
 *  normal day's out-and-back without reaching the opposite sleep window. */
const RESIDENTIAL_FALLBACK_MAX_GAP_SEC = 12 * 3600;

/** Pick the place attribute of a stationary segment to represent
 *  where the sleep happened.
 *
 *  A RESIDENTIAL place (one in `residentialPlaces` — a focus place the
 *  user sleeps at, e.g. Home) always wins over a non-residential one: you
 *  sleep at a residence, not at a hospital or café. Within the same
 *  residential/non-residential tier the smallest time gap to the window
 *  wins — gap=0 for an overlap (the common morning case where the wake-up
 *  endpoint lands inside today's first stationary segment); positive for
 *  the fallback case where the first fix arrives hours after wake-up.
 *
 *  This is the fix for the "walked straight out of home" day (2026-06-24):
 *  with no stationary Home segment near the wake-up (the morning starts
 *  with a *walk* out of the door) and no overnight GPS, the nearest
 *  stationary place was the hospital. A residential Home stay later in the
 *  day must still anchor the night.
 *
 *  Residential candidates get the more generous
 *  `RESIDENTIAL_FALLBACK_MAX_GAP_SEC`; non-residential keep the tight
 *  `PLACE_FALLBACK_MAX_GAP_SEC`.
 *
 *  Returns null when:
 *    - the sleep occurred entirely inside moving segments
 *      (overnight train) AND no stationary segment lies within range
 *      of either window edge, or
 *    - no in-range stationary segment has a place tag.
 *
 *  Pure function — the segments pipeline produces the candidates;
 *  this helper only consults them. `residentialPlaces` defaults to empty,
 *  in which case every candidate is non-residential and the behaviour is
 *  pure nearest-gap (the pre-fix contract). */
export function derivePlaceForSleep(
	window: { startTs: number; endTs: number },
	segments: readonly EnrichedSegment[],
	residentialPlaces: ReadonlySet<string> = EMPTY_RESIDENTIAL,
): string | null {
	let best: { place: string; gap: number; residential: boolean } | null = null;
	for (const s of segments) {
		if ((s.refinedMode ?? s.mode) !== "stationary") continue;
		if (s.place === undefined) continue;
		// gap=0 when the segment overlaps the window; positive otherwise,
		// collapsing both before-window and after-window cases.
		const gap =
			s.startTs > window.endTs ? s.startTs - window.endTs : window.startTs > s.endTs ? window.startTs - s.endTs : 0;
		const residential = residentialPlaces.has(s.place);
		const cap = residential ? RESIDENTIAL_FALLBACK_MAX_GAP_SEC : PLACE_FALLBACK_MAX_GAP_SEC;
		if (gap > cap) continue;
		// A residential candidate always beats a non-residential one; within
		// the same tier, the smaller gap wins.
		const better = !best || (residential && !best.residential) || (residential === best.residential && gap < best.gap);
		if (better) best = { place: s.place, gap, residential };
	}
	return best?.place ?? null;
}

const EMPTY_RESIDENTIAL: ReadonlySet<string> = new Set();

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
 *  the full `SleepWindow` shape the day-state converter expects.
 *  `residentialPlaces` (display names of focus places the user sleeps at)
 *  lets a residence anchor the sleep label over a nearer non-residential
 *  stop — see {@link derivePlaceForSleep}. */
export function enrichSleepWindows(
	raw: readonly RawSleepWindow[],
	segments: readonly EnrichedSegment[],
	residentialPlaces: ReadonlySet<string> = EMPTY_RESIDENTIAL,
): SleepWindow[] {
	return raw.map((w) => ({
		startTs: w.startTs,
		endTs: w.endTs,
		tz: w.tz,
		minutesAsleep: w.minutesAsleep,
		place: derivePlaceForSleep(w, segments, residentialPlaces),
	}));
}
