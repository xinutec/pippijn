/**
 * Probabilistic place assignment for stationary segments.
 *
 * Given a segment's spatial centroid and a list of candidate focus_places
 * (the user's mined long-term clusters), this module picks the most
 * likely place by combining:
 *
 *   - Log-likelihood on distance: Gaussian centred at the place's
 *     stored centroid, σ = the place's empirical radius. So a fix
 *     two empirical-σ off-centre takes a -2 hit; a fix five σ off
 *     is essentially zero probability.
 *   - Log-prior on visit frequency: log(unique_days + 1). A place
 *     you've been to 200 times beats one you've been to once,
 *     all else equal.
 *   - Log-prior on time-of-day: for sleep windows, log(sleep_hours
 *     + 1); for daytime stationary segments, log(awake_hours + 1).
 *     "You've slept at this place 1500 hours" overwhelms a co-located
 *     focus_place that's never seen a sleep, and vice versa for
 *     daytime stays at an office.
 *
 * `pickBestPlace` returns the argmax, or `null` when no candidate
 * crosses a posterior threshold. Callers fall through to OSM-amenity
 * lookup on null — that's the path for "you went somewhere new, you've
 * never been to McDonald's before, it's not in focus_places, so the
 * amenity-lookup-from-OSM tells us you're at a McDonald's."
 *
 * Replaces the old `snapToPlace + shouldUseClusterAmenity + residence-
 * hours-this-day` chain of heuristics. The previous gates were
 * day-local; the new scorer uses all-history priors directly off
 * the focus_places row.
 */

import { haversineMeters } from "./place-snap.js";

export interface PlaceCandidate {
	id: number;
	centroidLat: number;
	centroidLon: number;
	/** Empirical scatter of the cluster — used as σ for the
	 *  distance Gaussian. Floored at SIGMA_FLOOR_M to avoid
	 *  pathologically narrow places. */
	radiusM: number;
	/** Distinct days this place has been visited. */
	uniqueDays: number;
	/** Total observed dwell time at this place, across all visits. */
	totalDwellSec: number;
	/** Subset of total dwell that overlapped a sleep window (Fitbit
	 *  + day-state model). */
	sleepHours: number;
	displayName: string | null;
	amenityLabel: string | null;
}

/** Lower bound on the distance σ for the place-likelihood Gaussian.
 *
 *  focus_places.radius_m is the spread of the clustering algorithm's
 *  centroid estimate (~25 m for a single-storey building). The
 *  spread of typical GPS fixes when a user is AT that place is much
 *  larger — indoor multipath, building corners, the user walking
 *  in and out, accuracy variations across the day. Production data
 *  shows day-of fix clusters routinely sit 100–200 m from a known
 *  place's centroid even when the user definitively didn't leave.
 *
 *  We treat the place's `radius_m` as a lower bound on σ but floor
 *  it at 100 m so the Gaussian doesn't go to ~0 for ordinary
 *  GPS-noise distances. The frequency + time priors then drive
 *  the final ranking. */
const SIGMA_FLOOR_M = 100;

/** Don't pick a place whose best score is worse than this many
 *  log-points below "fix sits exactly at the centroid + max
 *  frequency + time match". Roughly: distance > 4σ off + low
 *  history. Tuned by the regression tests. */
const POSTERIOR_FLOOR = -8;

export function scorePlaceForSegment(
	candidate: PlaceCandidate,
	segCentroidLat: number,
	segCentroidLon: number,
	options: { isSleepWindow: boolean },
): number {
	const distM = haversineMeters(candidate.centroidLat, candidate.centroidLon, segCentroidLat, segCentroidLon);
	const sigma = Math.max(SIGMA_FLOOR_M, candidate.radiusM);
	// log-likelihood under Gaussian, constant terms dropped (we argmax).
	const logLikelihood = -(distM * distM) / (2 * sigma * sigma);

	// Prior on visit frequency. log(unique_days + 1) so the prior is
	// well-defined for never-visited places (log(1) = 0) and grows
	// gently — log-linear, so a place visited 500 times beats one
	// visited 5 times by log(500)-log(5) ≈ 4.6 points, which can be
	// outweighed by ~3σ of distance evidence. That's the right
	// tradeoff: lots of prior loses to strong distance evidence.
	const logPriorFreq = Math.log(candidate.uniqueDays + 1);

	// Prior on time-of-day match.
	const sleepHrs = Math.max(0, candidate.sleepHours);
	const totalHrs = Math.max(0, candidate.totalDwellSec / 3600);
	const awakeHrs = Math.max(0, totalHrs - sleepHrs);
	const logPriorTime = options.isSleepWindow ? Math.log(sleepHrs + 1) : Math.log(awakeHrs + 1);

	return logLikelihood + logPriorFreq + logPriorTime;
}

/** Pick the focus_place with the highest posterior score, or
 *  `null` when the best candidate's score is below the floor
 *  (typically: every candidate is too far away). */
export function pickBestPlace(
	candidates: readonly PlaceCandidate[],
	segCentroidLat: number,
	segCentroidLon: number,
	options: { isSleepWindow: boolean },
): { winner: PlaceCandidate; score: number } | null {
	if (candidates.length === 0) return null;
	let best: { winner: PlaceCandidate; score: number } | null = null;
	for (const c of candidates) {
		const s = scorePlaceForSegment(c, segCentroidLat, segCentroidLon, options);
		if (!best || s > best.score) best = { winner: c, score: s };
	}
	if (best && best.score < POSTERIOR_FLOOR) return null;
	return best;
}
