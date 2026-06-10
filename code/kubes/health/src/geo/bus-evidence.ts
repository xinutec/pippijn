/**
 * Bus-vs-car evidence for road-vehicle segments (task #247).
 *
 * From first principles, what separates a bus from a car/taxi on the
 * same streets is WHERE it stops, not how it moves:
 *
 *   - A bus is boarded at a flag: a 45s–5min standstill immediately
 *     before the vehicle pulls away, located at a `bus_stop` node.
 *   - A bus dwells mid-leg at the same fixed public stops every time;
 *     a car dwells at traffic signals.
 *   - A leg with several dwells and not one near a bus stop leans taxi.
 *
 * Useless discriminators (measured): average speed — London buses and
 * cars both crawl at ~13 km/h — and biometrics (sitting either way).
 *
 * Everything here is weighted evidence in nats, mirroring the mode
 * factor scorer's discipline: per-signal caps, no vetoes, a conservative
 * threshold. The pure functions below know nothing about OSM — the
 * orchestrator resolves stop/signal distances per dwell via
 * `nearbyTransitStops` and hands in the numbers.
 */

import type { FilteredPoint } from "./kalman.js";

/** A standstill within a moving leg. */
export interface VehicleDwell {
	startTs: number;
	endTs: number;
	durationS: number;
	/** Dwell centroid — where to query for nearby stops/signals. */
	lat: number;
	lon: number;
}

/** Distances from one dwell's centroid to transit furniture, as
 *  resolved by the orchestrator. Null = nothing within query radius. */
export interface DwellStopMatch {
	durationS: number;
	nearestBusStopM: number | null;
	nearestSignalM: number | null;
}

export interface BusEvidence {
	/** Duration of the pre-leg standstill, or null when the vehicle was
	 *  approached rolling (taxi pattern / no data). */
	boardingWaitS: number | null;
	/** Distance from the wait centroid to the nearest bus stop. */
	boardingNearestBusStopM: number | null;
	dwells: DwellStopMatch[];
}

// --- calibration -------------------------------------------------------------

/** A stop/signal "at" a dwell: within the urban GPS-noise scale. */
export const TRANSIT_STOP_NEAR_M = 35;

/** Boarding wait gates: shorter is a traffic pause, longer (past the
 *  lookback) is a prior stay, not a wait for this vehicle. */
const BOARDING_WAIT_MIN_S = 45;
const BOARDING_WAIT_LOOKBACK_S = 5 * 60;

/** Mid-leg dwell gates: 20s+ under walking pace. Signal stops are
 *  often this long too — which is why a dwell only counts as bus
 *  evidence when it coincides with a bus stop. */
const DWELL_MIN_S = 20;
const DWELL_MAX_SPEED_KMH = 3;

/** Weights (nats). Boarding at a stop is the strongest single signal;
 *  each stop-coinciding dwell adds, capped so a crawling leg past many
 *  stops cannot run away; several dwells with no stop near any of them
 *  is mild taxi evidence. */
const BOARDING_AT_STOP_NATS = 1.5;
const BOARDING_NO_STOP_DATA_NATS = 0.2;
const DWELL_AT_STOP_NATS = 0.8;
/** A dwell near BOTH a stop and a signal is ambiguous — half credit. */
const DWELL_AT_STOP_AND_SIGNAL_NATS = 0.4;
const DWELL_CREDIT_CAP_NATS = 2.4;
const MANY_DWELLS_NO_STOP_NATS = -0.8;
const MANY_DWELLS_MIN = 3;

/** Total evidence at/above this labels the leg a bus. Calibration:
 *  boarding-at-stop alone (1.5) is not enough; boarding + one stop
 *  dwell (2.3) is; three stop dwells without a visible boarding (2.4)
 *  is. */
export const BUS_EVIDENCE_THRESHOLD_NATS = 2.0;

// --- geometry helpers ---------------------------------------------------------

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type Fix = Pick<FilteredPoint, "ts" | "lat" | "lon">;

/** Speed between two fixes in km/h; Infinity for zero/negative dt so a
 *  duplicate timestamp can never read as a standstill. */
function pairSpeedKmh(a: Fix, b: Fix): number {
	const dt = b.ts - a.ts;
	if (dt <= 0) return Number.POSITIVE_INFINITY;
	return (haversineMeters(a.lat, a.lon, b.lat, b.lon) / dt) * 3.6;
}

// --- detection ----------------------------------------------------------------

/**
 * The standstill immediately preceding `segStartTs` — the would-be
 * boarding wait. Walks backwards from the leg start through fixes in
 * the lookback window while consecutive pair speeds stay under walking
 * pace; returns null when the contiguous standstill is shorter than
 * BOARDING_WAIT_MIN_S (rolling approach = taxi pattern, or no data).
 */
export function detectBoardingWait(
	fixes: readonly Fix[],
	segStartTs: number,
): { durationS: number; lat: number; lon: number } | null {
	const pre = fixes.filter((p) => p.ts <= segStartTs && p.ts >= segStartTs - BOARDING_WAIT_LOOKBACK_S);
	if (pre.length < 2) return null;
	let from = pre.length - 1;
	while (from > 0 && pairSpeedKmh(pre[from - 1], pre[from]) < DWELL_MAX_SPEED_KMH) from--;
	const still = pre.slice(from);
	const durationS = still[still.length - 1].ts - still[0].ts;
	if (durationS < BOARDING_WAIT_MIN_S) return null;
	const lat = still.reduce((s, p) => s + p.lat, 0) / still.length;
	const lon = still.reduce((s, p) => s + p.lon, 0) / still.length;
	return { durationS, lat, lon };
}

/**
 * Standstill runs inside the moving leg: maximal runs of consecutive
 * pair speeds under DWELL_MAX_SPEED_KMH lasting ≥ DWELL_MIN_S. The
 * dwell centroid is where the orchestrator queries for stop/signal
 * proximity.
 */
export function detectVehicleDwells(fixes: readonly Fix[], startTs: number, endTs: number): VehicleDwell[] {
	const inLeg = fixes.filter((p) => p.ts >= startTs && p.ts <= endTs);
	const dwells: VehicleDwell[] = [];
	let runStart = -1;
	for (let i = 1; i <= inLeg.length; i++) {
		const slow = i < inLeg.length && pairSpeedKmh(inLeg[i - 1], inLeg[i]) < DWELL_MAX_SPEED_KMH;
		if (slow && runStart < 0) runStart = i - 1;
		if (!slow && runStart >= 0) {
			const run = inLeg.slice(runStart, i);
			const durationS = run[run.length - 1].ts - run[0].ts;
			if (durationS >= DWELL_MIN_S) {
				dwells.push({
					startTs: run[0].ts,
					endTs: run[run.length - 1].ts,
					durationS,
					lat: run.reduce((s, p) => s + p.lat, 0) / run.length,
					lon: run.reduce((s, p) => s + p.lon, 0) / run.length,
				});
			}
			runStart = -1;
		}
	}
	return dwells;
}

// --- scoring ------------------------------------------------------------------

export interface BusEvidenceScore {
	total: number;
	parts: {
		boarding: number;
		dwellCredit: number;
		noStopPenalty: number;
	};
}

/** Sum the weighted evidence. See the weight constants for rationale. */
export function scoreBusEvidence(ev: BusEvidence): BusEvidenceScore {
	let boarding = 0;
	if (ev.boardingWaitS !== null) {
		boarding =
			ev.boardingNearestBusStopM !== null && ev.boardingNearestBusStopM <= TRANSIT_STOP_NEAR_M
				? BOARDING_AT_STOP_NATS
				: BOARDING_NO_STOP_DATA_NATS;
	}

	let dwellCredit = 0;
	let stopDwells = 0;
	for (const d of ev.dwells) {
		const atStop = d.nearestBusStopM !== null && d.nearestBusStopM <= TRANSIT_STOP_NEAR_M;
		const atSignal = d.nearestSignalM !== null && d.nearestSignalM <= TRANSIT_STOP_NEAR_M;
		if (atStop) {
			stopDwells++;
			dwellCredit += atSignal ? DWELL_AT_STOP_AND_SIGNAL_NATS : DWELL_AT_STOP_NATS;
		}
		// A dwell at a signal only: any road vehicle — no contribution.
	}
	dwellCredit = Math.min(dwellCredit, DWELL_CREDIT_CAP_NATS);

	const noStopPenalty = ev.dwells.length >= MANY_DWELLS_MIN && stopDwells === 0 ? MANY_DWELLS_NO_STOP_NATS : 0;

	return { total: boarding + dwellCredit + noStopPenalty, parts: { boarding, dwellCredit, noStopPenalty } };
}
