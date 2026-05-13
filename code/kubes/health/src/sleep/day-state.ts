/**
 * DayState — bottom layer of the three-altitude data model.
 *
 * Each `DayState` is a non-overlapping interval describing one thing
 * the person was doing. Mode is mutually exclusive at any moment;
 * `sleeping` is one mode. Attributes qualify the state (e.g.
 * `asleep` on a moving state means sleeping-while-in-transit).
 * Spans bigger than one state (city, journey, day-part) live in a
 * separate "overlay" layer outside this module.
 *
 * Sleep is rendered for the FULL Fitbit window — not clipped to
 * the segments that happen to overlap. Concretely: morning sleep
 * that began at 23:43 yesterday with first GPS fix at 07:47 today
 * is shown as a single sleeping state from 23:43 yesterday to the
 * wake-up timestamp. The "your day" narrative tells me when I fell
 * asleep, not just the slice between fixes.
 *
 * Algorithm: boundary sweep. Collect every distinct boundary
 * timestamp from segments and sleep windows, then for each
 * sub-interval pick the state from the (at most one) overlapping
 * segment and the (at most one) overlapping sleep window. Synthetic
 * sleeping states fill sleep-window gaps that no segment covers.
 *
 * The converter is pure: no DB access, no side effects.
 */

import type { EnrichedSegment } from "../geo/velocity.js";

export type DayStateMode = "sleeping" | "stationary" | "walking" | "cycling" | "driving" | "train" | "plane";

export interface SleepWindow {
	startTs: number;
	endTs: number;
	/** Place name (e.g. "Home", "Hotel X"). Used to decide whether
	 *  to rewrite an overlapping stationary segment to sleeping
	 *  mode AND to label the synthesized sleeping state when no
	 *  segment covers the gap. Null means the sleep occurred while
	 *  moving (overnight train, plane) — no place to match, no
	 *  synthesis. */
	place: string | null;
	minutesAsleep: number;
	tz: string | null;
}

export interface DayState {
	startTs: number;
	endTs: number;
	mode: DayStateMode;
	/** Human-readable place label (for stationary / sleeping). */
	place?: string;
	/** Human-readable way label (for moving — road, line, station-pair). */
	wayName?: string;
	/** True when the user was asleep but the underlying state is
	 *  not "sleeping" (i.e. sleeping while in transit). When mode
	 *  itself is "sleeping" this attribute is omitted — would be
	 *  redundant. */
	asleep?: boolean;
	/** IANA tz the state's timestamps should render in. Sourced
	 *  from the underlying segment's displayTz, or from the sleep
	 *  window's tz for synthesized sleeping intervals. */
	tz?: string;
}

/** Public entry: convert segments + sleep windows into the day's
 *  non-overlapping state sequence. Adjacent same-state runs are
 *  merged. */
export function segmentsToDayStates(
	segments: readonly EnrichedSegment[],
	sleepWindows: readonly SleepWindow[],
): DayState[] {
	const boundaries = collectBoundaries(segments, sleepWindows);
	if (boundaries.length < 2) return [];

	const states: DayState[] = [];
	for (let i = 0; i < boundaries.length - 1; i++) {
		const start = boundaries[i];
		const end = boundaries[i + 1];
		const mid = start + (end - start) / 2;
		const seg = findCovering(segments, mid);
		const sleep = findCoveringSleep(sleepWindows, mid);
		const state = stateForInterval(start, end, seg, sleep);
		if (state) states.push(state);
	}
	return mergeAdjacent(states);
}

function collectBoundaries(segments: readonly EnrichedSegment[], sleepWindows: readonly SleepWindow[]): number[] {
	const set = new Set<number>();
	for (const s of segments) {
		set.add(s.startTs);
		set.add(s.endTs);
	}
	for (const w of sleepWindows) {
		set.add(w.startTs);
		set.add(w.endTs);
	}
	return [...set].sort((a, b) => a - b);
}

function findCovering(segments: readonly EnrichedSegment[], ts: number): EnrichedSegment | undefined {
	return segments.find((s) => s.startTs <= ts && ts < s.endTs);
}

function findCoveringSleep(sleepWindows: readonly SleepWindow[], ts: number): SleepWindow | undefined {
	return sleepWindows.find((w) => w.startTs <= ts && ts < w.endTs);
}

function stateForInterval(
	start: number,
	end: number,
	seg: EnrichedSegment | undefined,
	sleep: SleepWindow | undefined,
): DayState | null {
	// No segment, no sleep — nothing to say about this interval.
	// Happens when sleep windows leave gaps between today's morning
	// and evening sleep (the awake hours that have no segments — but
	// those are usually filled, so this is only the very-edge case
	// of "no data at all").
	if (!seg && !sleep) return null;

	// Sleep window covers a stretch with no GPS coverage: emit a
	// synthesized sleeping state at the sleep place. This is what
	// makes the morning-sleep-before-first-fix and evening-sleep-
	// after-last-fix narratives appear in the timeline.
	if (!seg && sleep) {
		if (sleep.place === null) return null; // overnight in transit, no place → can't synthesize
		const out: DayState = { startTs: start, endTs: end, mode: "sleeping", place: sleep.place };
		if (sleep.tz) out.tz = sleep.tz;
		return out;
	}

	// From here on, seg is defined (TypeScript narrowing).
	const segment = seg as EnrichedSegment;
	const segMode = (segment.refinedMode ?? segment.mode) as DayStateMode;

	if (!sleep) {
		return makeStateFromSegment(segment, start, end, segMode, false);
	}

	// Sleep window overlaps this segment-covered interval.
	if (segMode === "stationary") {
		// Stationary at sleep place → sleeping mode.
		if (sleep.place !== null && segment.place === sleep.place) {
			const out: DayState = { startTs: start, endTs: end, mode: "sleeping", place: segment.place };
			if (segment.displayTz) out.tz = segment.displayTz;
			else if (sleep.tz) out.tz = sleep.tz;
			return out;
		}
		// Stationary at a different place (user awake at the desk
		// while Fitbit thinks they're asleep): defer to GPS.
		return makeStateFromSegment(segment, start, end, segMode, false);
	}

	// Moving + sleep window → keep mode, add asleep attribute.
	return makeStateFromSegment(segment, start, end, segMode, true);
}

function makeStateFromSegment(
	seg: EnrichedSegment,
	startTs: number,
	endTs: number,
	mode: DayStateMode,
	asleep: boolean,
): DayState {
	const state: DayState = { startTs, endTs, mode };
	if (seg.place !== undefined) state.place = seg.place;
	if (seg.wayName !== undefined) state.wayName = seg.wayName;
	if (asleep && mode !== "sleeping") state.asleep = true;
	if (seg.displayTz) state.tz = seg.displayTz;
	return state;
}

function mergeAdjacent(states: readonly DayState[]): DayState[] {
	const out: DayState[] = [];
	for (const s of states) {
		const prev = out[out.length - 1];
		if (prev && prev.endTs === s.startTs && sameState(prev, s)) {
			prev.endTs = s.endTs;
		} else {
			out.push({ ...s });
		}
	}
	return out;
}

function sameState(a: DayState, b: DayState): boolean {
	return a.mode === b.mode && a.place === b.place && a.wayName === b.wayName && a.asleep === b.asleep && a.tz === b.tz;
}
