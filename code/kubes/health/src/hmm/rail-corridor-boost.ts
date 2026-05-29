/**
 * Rail-corridor boost: per-minute emission credit for `train @ L`
 * states when the bookend GPS fixes are within walking distance of
 * stations on line L.
 *
 * Motivation (2026-05-26):
 *
 *   Geometric feasibility correctly knocks `stat @ Home` out of the
 *   2026-05-22 20:05-20:13 tube-tunnel gap, but the HSMM falls back
 *   to `stat @ (none)` rather than `train @ Metropolitan Line`
 *   because train @ L has no positive emission signal beyond the
 *   mode prior (which is small: log(0.05) = -3 nats/min). The bookend
 *   evidence — Pentonville Road (~500 m from King's Cross Met
 *   station) at 20:03 and Finchley Road (Met station, ~100 m away)
 *   at 20:16 — is the structural argument that this gap is a Met
 *   Line ride.
 *
 *   This factor turns that structural evidence into a per-minute
 *   log-prob boost. Calibrated so the boost (~+3.5 nats/min) is
 *   enough to overcome stat @ none's mode-prior advantage (~+2.6
 *   nats/min vs train) AND leave room for the geometric / sleep /
 *   place-distance factors to dominate when they fire.
 *
 *   Targeted scope:
 *   - Only fires for `train @ knownLine` (lineName != "unknown_rail").
 *     Without a specific line, there are no station coordinates to
 *     corroborate, so the boost doesn't apply.
 *   - Both prev AND next fix must be near a station on the line.
 *     One-sided evidence isn't enough — the user could have walked
 *     into a tunnel from somewhere unrelated and emerged at a Met
 *     station, but the gap shouldn't be classified as Met.
 *
 * Pure module. No DB, no IO, no globals.
 */

import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

export interface BuildRailCorridorBoostOpts {
	/** Station coordinates per line, as returned by
	 *  `stationsOnLine`. The CLI builds this once from `KNOWN_LINES`. */
	stationsByLine: ReadonlyMap<string, readonly { lat: number; lon: number }[]>;
}

export type RailCorridorBoostFn = (state: State, obs: Observation) => number;

/** Walking-distance radius from a station for a fix to count as
 *  "near the line." 600 m matches the conservative walk between
 *  street GPS at a station entrance and the underground platform
 *  in a typical London cluster. */
const STATION_PROXIMITY_M = 600;

/** Minimum gap duration (seconds) between prev and next fix for
 *  the boost to fire. Below this the gap is more consistent with
 *  an indoor / multipath blip at a single location than with a
 *  real tube ride. Tuned so that constant GPS flicker at central-
 *  London places (Work, Cleveland Clinic) doesn't trigger the
 *  boost on every individual gap minute. */
const MIN_GAP_DURATION_S = 5 * 60;

/** Minimum straight-line distance (metres) between prev and next
 *  fix for the boost to fire. Below this — even with a long
 *  duration gap — the user hasn't physically moved enough for a
 *  meaningful tube ride between two stations. */
const MIN_GAP_DISTANCE_M = 1_000;

/** Per-minute boost magnitude. Tuned so a train @ L candidate
 *  beats stat @ none (~+3 nats/min mode-prior advantage to stat)
 *  when the structural rail evidence is unambiguous. Smaller
 *  values let the gap interpretation fall back to stat @ none;
 *  larger values risk over-rotating into train on weak evidence. */
const RAIL_CORRIDOR_BOOST = 3.5;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearAnyStation(fix: { lat: number; lon: number }, stations: readonly { lat: number; lon: number }[]): boolean {
	for (const s of stations) {
		if (haversineMeters(fix.lat, fix.lon, s.lat, s.lon) <= STATION_PROXIMITY_M) return true;
	}
	return false;
}

export function buildRailCorridorBoost(opts: BuildRailCorridorBoostOpts): RailCorridorBoostFn {
	const stationsByLine = opts.stationsByLine;
	return (state: State, obs: Observation): number => {
		if (state.mode !== "train") return 0;
		if (state.lineName === null || state.lineName === "unknown_rail") return 0;
		// Only fire on GPS-null minutes — the boost is meant to identify
		// underground tube tunnel rides where GPS goes dark between two
		// observed near-station fixes. When the minute has GPS, the user
		// is observed; place-distance / mode-specific emissions handle
		// the disambiguation. Without this gate, the boost over-rotates
		// stationary stays at central-London places (Work, Cleveland
		// Clinic) near Met-corridor stations into train @ Met (audit
		// regression noted 2026-05-28).
		if (obs.gps !== null) return 0;
		const stations = stationsByLine.get(state.lineName);
		if (stations === undefined || stations.length === 0) return 0;
		const prev = obs.prevGpsFix;
		const next = obs.nextGpsFix;
		if (prev === null || next === null) return 0;
		// The gap between fixes must be both long enough AND span
		// enough distance to plausibly be a tube ride. Otherwise
		// central-London indoor GPS flicker (Work, clinic visits)
		// triggers the boost on every gap minute even though no ride
		// took place.
		if (next.ts - prev.ts < MIN_GAP_DURATION_S) return 0;
		if (haversineMeters(prev.lat, prev.lon, next.lat, next.lon) < MIN_GAP_DISTANCE_M) return 0;
		if (!nearAnyStation(prev, stations)) return 0;
		if (!nearAnyStation(next, stations)) return 0;
		return RAIL_CORRIDOR_BOOST;
	};
}
