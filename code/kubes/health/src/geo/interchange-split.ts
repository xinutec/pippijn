/**
 * Interchange decomposition (task #222).
 *
 * A train segment whose board and alight stations share no common line
 * is physically impossible as one ride — #181's validity constraint
 * turned into a repair: split it into two legs at the watch-timed
 * interchange.
 *
 * Evidence, in the order it is applied:
 *
 *   1. **The watch times the change.** Underground the GPS is dark, but
 *      the step counter keeps recording. A walk–pause–walk burst of
 *      walking-cadence minutes in the middle of a "train" segment is
 *      the platform-to-platform interchange walk (measured shape:
 *      18, 112, 4, 113, 18 steps/min over five minutes).
 *   2. **The line graph names the candidates.** The interchange must be
 *      a station present on BOTH a line serving the board end and a
 *      line serving the alight end.
 *   3. **Timing picks among candidates.** Expected arrival at candidate
 *      X ≈ leg start + boarding wait + distance-derived ride time.
 *      Validated on the motivating leg: the timing fit picked the
 *      user-confirmed change where resurfacing geometry could not (the
 *      two onward corridors run parallel).
 *
 * Pure functions here; the orchestration (line lookups via the OSM
 * adapter, segment splicing) lives with the velocity pipeline wiring.
 */

import type { StepPoint } from "./biometrics.js";
import type { Station } from "./line-stations.js";

// --- burst detection ---------------------------------------------------------

/** A minute at or above this cadence is interchange walking. Platform
 *  walks are brisk; anything below is in-seat fidgeting. */
const BURST_MIN_CADENCE = 40;

/** Burst minutes joined into one event when separated by at most this
 *  many quiet minutes (the mid-burst pause: corridors, escalators,
 *  waiting for the platform to clear). */
const BURST_JOIN_GAP_MIN = 2;

/** A burst shorter than this is a single fidget minute; longer than the
 *  max is not an interchange (nobody walks 10 minutes inside one). */
const BURST_MIN_MIN = 2;
const BURST_MAX_MIN = 8;

/** Bursts starting within this many seconds of either leg edge are the
 *  boarding/alighting walks bleeding into the segment, not a change. */
const BURST_EDGE_GUARD_S = 3 * 60;

export interface InterchangeBurst {
	startTs: number;
	endTs: number;
}

/**
 * The single watch-timed interchange burst inside a train leg, or null
 * when there is none / it is ambiguous (two separate bursts) / it hugs
 * a leg edge. Conservative: a null leaves the leg untouched.
 */
export function findInterchangeBurst(
	steps: readonly StepPoint[],
	legStartTs: number,
	legEndTs: number,
): InterchangeBurst | null {
	const walkMinutes = steps
		.filter((s) => s.ts > legStartTs && s.ts < legEndTs && s.steps >= BURST_MIN_CADENCE)
		.map((s) => s.ts)
		.sort((a, b) => a - b);
	if (walkMinutes.length === 0) return null;

	// Group into bursts, joining across short pauses.
	const bursts: InterchangeBurst[] = [];
	let start = walkMinutes[0];
	let prev = walkMinutes[0];
	for (const ts of walkMinutes.slice(1)) {
		if (ts - prev > BURST_JOIN_GAP_MIN * 60 + 60) {
			bursts.push({ startTs: start, endTs: prev + 60 });
			start = ts;
		}
		prev = ts;
	}
	bursts.push({ startTs: start, endTs: prev + 60 });

	const mid = bursts.filter(
		(b) => b.startTs >= legStartTs + BURST_EDGE_GUARD_S && b.endTs <= legEndTs - BURST_EDGE_GUARD_S,
	);
	if (mid.length !== 1) return null; // none, or ambiguous
	const b = mid[0];
	const durMin = (b.endTs - b.startTs) / 60;
	if (durMin < BURST_MIN_MIN || durMin > BURST_MAX_MIN) return null;
	return b;
}

// --- candidate scoring --------------------------------------------------------

/** Typical boarding wait between entering the station and the first
 *  train moving (ticket line + platform + headway). */
const BOARD_WAIT_S = 3 * 60;

/** Distance-derived ride-time estimate: metro averages ~1.1 km between
 *  stations at ~120 s per hop including the dwell. Crude on purpose —
 *  it only has to ORDER candidates, not predict arrival to the minute. */
const AVG_INTERSTATION_M = 1_100;
const PER_STOP_S = 120;

/** Candidates whose best timing fit misses the burst by more than this
 *  are wrong — better to leave the leg whole than to invent a change. */
const MAX_TIMING_SLOP_S = 6 * 60;

/** Within this distance of the board/alight ends a "candidate" is the
 *  end itself, not a change between them. */
const ENDPOINT_EXCLUSION_M = 400;

export interface InterchangePick {
	station: string;
	lat: number;
	lon: number;
	lineA: string;
	lineB: string;
	/** |expected arrival − burst start|, for confidence reporting. */
	timingSlopS: number;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Pick the interchange station for a board→alight pair with no common
 * line: the station on both a board-end line and an alight-end line
 * whose distance-derived arrival time best matches the burst. Null when
 * no candidate exists or even the best fit is outside
 * MAX_TIMING_SLOP_S.
 */
export function pickInterchange(opts: {
	boardLat: number;
	boardLon: number;
	alightLat: number;
	alightLon: number;
	legStartTs: number;
	burstStartTs: number;
	linesA: readonly string[];
	linesB: readonly string[];
	stationsByLine: ReadonlyMap<string, readonly Station[]>;
}): InterchangePick | null {
	let best: InterchangePick | null = null;
	for (const lineA of opts.linesA) {
		const aStations = opts.stationsByLine.get(lineA) ?? [];
		const aNames = new Map(aStations.map((s) => [s.name, s]));
		for (const lineB of opts.linesB) {
			if (lineB === lineA) continue; // a shared line = valid triple, not ours to split
			for (const sb of opts.stationsByLine.get(lineB) ?? []) {
				const sa = aNames.get(sb.name);
				if (!sa) continue;
				// The change is BETWEEN the ends, not at them.
				if (haversineMeters(sa.lat, sa.lon, opts.boardLat, opts.boardLon) < ENDPOINT_EXCLUSION_M) continue;
				if (haversineMeters(sa.lat, sa.lon, opts.alightLat, opts.alightLon) < ENDPOINT_EXCLUSION_M) continue;
				const rideM = haversineMeters(opts.boardLat, opts.boardLon, sa.lat, sa.lon);
				const expectedTs = opts.legStartTs + BOARD_WAIT_S + (rideM / AVG_INTERSTATION_M) * PER_STOP_S;
				const slop = Math.abs(expectedTs - opts.burstStartTs);
				if (slop > MAX_TIMING_SLOP_S) continue;
				if (!best || slop < best.timingSlopS) {
					best = { station: sb.name, lat: sa.lat, lon: sa.lon, lineA, lineB, timingSlopS: slop };
				}
			}
		}
	}
	return best;
}
