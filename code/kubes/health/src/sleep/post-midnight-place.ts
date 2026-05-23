/**
 * Detect "where was the user at post-midnight time T" from raw GPS
 * fixes, matched against the user's mined focus places.
 *
 * Used by the sleep-place attribution path: today's segments end at
 * day boundary (midnight, give or take a long taxi ride), but the
 * sleep window for tonight starts AFTER midnight. derivePlaceForSleep
 * needs candidates from BOTH today's segments AND tomorrow's morning
 * to attribute the sleep correctly. This module produces the latter
 * — a small set of synthetic stationary-stay candidates drawn from
 * raw next-day morning fixes.
 *
 * Pure: input fixes + known places, output candidate stays. No DB.
 *
 * Intentionally narrow: this is NOT a general-purpose stationary
 * detector — it deliberately rejects clusters that don't snap to a
 * known place (we only care about *named* places here; an
 * unattributed cluster of fixes is no better than the no-data
 * fallback). The full segmentation pipeline handles unnamed stays
 * elsewhere.
 */

import { haversineMeters } from "../geo/place-snap.js";

export interface StayFix {
	ts: number;
	lat: number;
	lon: number;
}

export interface StayKnownPlace {
	centroidLat: number;
	centroidLon: number;
	/** Match-radius in metres. Defaults to 50 m if omitted. */
	radiusM?: number;
	/** Place display name — null returned from this helper would defeat
	 *  its purpose, so callers should pre-filter known places to those
	 *  with non-null displayName. */
	displayName: string | null;
}

export interface StayCandidate {
	startTs: number;
	endTs: number;
	/** The matched known place's displayName. Guaranteed non-null —
	 *  candidates with no name match are not emitted. */
	place: string;
}

/** Minimum dwell duration (seconds). Shorter clusters are signal
 *  noise — a couple of fixes near a place don't prove the user was
 *  there. */
const MIN_DWELL_SEC = 10 * 60;

/** Max distance (m) from the running cluster centroid for a fix to
 *  count as part of the same cluster. Wider than typical home radius
 *  on purpose: GPS at home with phone on a desk can wander 50–100 m
 *  due to multipath. The downstream match-to-known-place step
 *  enforces the place's own radius. */
const CLUSTER_RADIUS_M = 100;

/** Build cluster runs from a fix series. A new run starts whenever
 *  the next fix is farther than CLUSTER_RADIUS_M from the running
 *  centroid. Runs shorter than MIN_DWELL_SEC are dropped. */
function clusterFixes(fixes: readonly StayFix[]): StayFix[][] {
	const runs: StayFix[][] = [];
	let current: StayFix[] = [];
	let centroidLat = 0;
	let centroidLon = 0;
	for (const fix of fixes) {
		if (current.length === 0) {
			current.push(fix);
			centroidLat = fix.lat;
			centroidLon = fix.lon;
			continue;
		}
		const distM = haversineMeters(centroidLat, centroidLon, fix.lat, fix.lon);
		if (distM > CLUSTER_RADIUS_M) {
			runs.push(current);
			current = [fix];
			centroidLat = fix.lat;
			centroidLon = fix.lon;
		} else {
			current.push(fix);
			centroidLat = current.reduce((s, f) => s + f.lat, 0) / current.length;
			centroidLon = current.reduce((s, f) => s + f.lon, 0) / current.length;
		}
	}
	if (current.length > 0) runs.push(current);
	return runs.filter((r) => r.length >= 2 && r[r.length - 1].ts - r[0].ts >= MIN_DWELL_SEC);
}

/** Snap a cluster centroid to a known place. Returns the matched
 *  place or null when the centroid is outside every place's radius.
 *  When two places are within radius, the closer one wins. */
function snapClusterToPlace(
	centroidLat: number,
	centroidLon: number,
	places: readonly StayKnownPlace[],
): StayKnownPlace | null {
	let best: { place: StayKnownPlace; distM: number } | null = null;
	for (const p of places) {
		const distM = haversineMeters(centroidLat, centroidLon, p.centroidLat, p.centroidLon);
		const radius = p.radiusM ?? 50;
		if (distM > radius) continue;
		if (!best || distM < best.distM) best = { place: p, distM };
	}
	return best?.place ?? null;
}

/** Public entry. Returns candidate stays (one per detected dwell
 *  cluster that snaps to a named known place). Each candidate is
 *  shaped so derivePlaceForSleep can consume it as if it were a
 *  stationary segment with a place. */
export function detectPostMidnightStays(
	fixes: readonly StayFix[],
	knownPlaces: readonly StayKnownPlace[],
): StayCandidate[] {
	if (fixes.length === 0 || knownPlaces.length === 0) return [];
	const namedPlaces = knownPlaces.filter((p): p is StayKnownPlace & { displayName: string } => p.displayName !== null);
	if (namedPlaces.length === 0) return [];
	const runs = clusterFixes(fixes);
	const out: StayCandidate[] = [];
	for (const run of runs) {
		const cLat = run.reduce((s, f) => s + f.lat, 0) / run.length;
		const cLon = run.reduce((s, f) => s + f.lon, 0) / run.length;
		const matched = snapClusterToPlace(cLat, cLon, namedPlaces);
		if (matched === null || matched.displayName === null) continue;
		out.push({
			startTs: run[0].ts,
			endTs: run[run.length - 1].ts,
			place: matched.displayName,
		});
	}
	return out;
}
