/**
 * DayState — bottom layer of the three-altitude data model.
 *
 * Each `DayState` is a non-overlapping interval describing one thing
 * the person was doing. Mode is mutually exclusive at any moment;
 * `sleeping` is one mode. Attributes qualify the state (e.g.
 * `asleep` on a moving state means sleeping-while-in-transit).
 * Spans bigger than one state (city, journey, day-part) live in a
 * separate "overlay" layer outside this module — see the
 * three-altitude design discussion in conversation 2026-05-13.
 *
 * Conversion rules from EnrichedSegment[] + SleepWindow[]:
 *
 *   - For each sleep window, identify the *sleep place* (the place
 *     attribute of stationary segments overlapping the window).
 *     `sleep.place` carries it from the caller; null means
 *     sleep-on-the-move and no place-rewrite happens.
 *   - A stationary segment at the sleep place, overlapping the
 *     window, gets the overlapping portion rewritten to mode
 *     "sleeping". The segment may split into pre-sleep,
 *     sleeping, and post-wake parts.
 *   - A non-stationary segment overlapping the window stays as
 *     its original mode, with an `asleep: true` attribute set on
 *     the overlapping portion. Splits at sleep boundaries.
 *   - Adjacent same-mode-same-place runs merge after rewriting.
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
	 *  mode. Null means the sleep occurred while moving (overnight
	 *  train, plane) — no place to match against. */
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
}

/** Public entry: convert segments + sleep windows into the day's
 *  non-overlapping state sequence. Adjacent same-state runs are
 *  merged. */
export function segmentsToDayStates(segments: readonly EnrichedSegment[], sleepWindows: readonly SleepWindow[]): DayState[] {
	// 1. Convert each segment to a DayState, possibly splitting/
	//    rewriting it where it overlaps a sleep window.
	const split: DayState[] = [];
	for (const seg of segments) {
		split.push(...splitSegmentBySleep(seg, sleepWindows));
	}

	// 2. Merge adjacent same-state runs. Same-state means:
	//    same mode, same place, same wayName, same asleep attribute.
	return mergeAdjacent(split);
}

function splitSegmentBySleep(seg: EnrichedSegment, sleeps: readonly SleepWindow[]): DayState[] {
	const mode = (seg.refinedMode ?? seg.mode) as DayStateMode;

	// Filter sleep windows to those that meaningfully apply to this
	// segment. A sleep window is relevant when it overlaps in time
	// AND triggers either a rewrite (stationary at sleep place) or
	// the asleep attribute (any moving mode). Stationary at a place
	// that isn't the sleep place is left untouched.
	const overlaps = sleeps
		.filter((s) => s.endTs > seg.startTs && s.startTs < seg.endTs)
		.filter((s) => isRelevantToSegment(mode, seg.place, s))
		.sort((a, b) => a.startTs - b.startTs);
	if (overlaps.length === 0) {
		return [segmentToBaseState(seg)];
	}

	const out: DayState[] = [];
	let cursor = seg.startTs;
	for (const sleep of overlaps) {
		const overlapStart = Math.max(cursor, sleep.startTs);
		const overlapEnd = Math.min(seg.endTs, sleep.endTs);
		// Pre-overlap region (if any)
		if (cursor < overlapStart) {
			out.push(makeState(seg, cursor, overlapStart, mode, false));
		}
		// The overlapping region: rewrite to sleeping if stationary
		// at sleep place; otherwise set asleep=true on the same mode.
		const rewriteToSleeping = mode === "stationary" && sleep.place !== null && seg.place === sleep.place;
		if (rewriteToSleeping) {
			out.push({
				startTs: overlapStart,
				endTs: overlapEnd,
				mode: "sleeping",
				place: seg.place,
			});
		} else {
			out.push(makeState(seg, overlapStart, overlapEnd, mode, true));
		}
		cursor = overlapEnd;
	}
	// Post-overlap remainder
	if (cursor < seg.endTs) {
		out.push(makeState(seg, cursor, seg.endTs, mode, false));
	}
	return out;
}

/** A sleep window is "relevant" to a segment iff applying it would
 *  change the segment's state representation. Stationary at the
 *  wrong place (user awake at work while their main sleep was at
 *  home) is left untouched — no split, no attribute. */
function isRelevantToSegment(mode: DayStateMode, segmentPlace: string | undefined, sleep: SleepWindow): boolean {
	if (mode === "stationary") {
		return sleep.place !== null && segmentPlace === sleep.place;
	}
	// Moving modes always carry the asleep attribute when overlapping
	// — sleeping-on-a-train is a real story we want to surface.
	return true;
}

function segmentToBaseState(seg: EnrichedSegment): DayState {
	const mode = (seg.refinedMode ?? seg.mode) as DayStateMode;
	return makeState(seg, seg.startTs, seg.endTs, mode, false);
}

function makeState(seg: EnrichedSegment, startTs: number, endTs: number, mode: DayStateMode, asleep: boolean): DayState {
	const state: DayState = { startTs, endTs, mode };
	if (seg.place !== undefined) state.place = seg.place;
	if (seg.wayName !== undefined) state.wayName = seg.wayName;
	if (asleep && mode !== "sleeping") state.asleep = true;
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
	return a.mode === b.mode && a.place === b.place && a.wayName === b.wayName && a.asleep === b.asleep;
}
