/**
 * Probabilistic place assignment for stationary segments.
 *
 * Given a segment's spatial centroid and a list of candidate focus_places
 * (the user's mined long-term clusters), this module picks the most
 * likely place by combining:
 *
 *   - Log-likelihood on distance: a Gaussian centred at the place's
 *     stored centroid. σ is the place's empirical radius, floored to
 *     a GPS-noise tolerance — wide for an established place, tight for
 *     a sparse one (see the SIGMA_FLOOR_* constants). A fix two σ
 *     off-centre takes a -2 hit; five σ off is ~zero probability.
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
 * lookup on null — that's the path for "you went somewhere new, the
 * place isn't in focus_places, so the amenity-lookup-from-OSM tells
 * us what kind of venue it is."
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

/** The distance σ for the place-likelihood Gaussian is `radius_m`
 *  floored to a GPS-noise tolerance that the place has *earned* by
 *  being visited. The floor slides continuously between two bounds as
 *  visit-days accumulate — there is no hard "established / not" step.
 *
 *  `SIGMA_FLOOR_MAX_M` — the floor a thoroughly-established place
 *  converges to. focus_places.radius_m is the spread of the
 *  clustering centroid estimate (~25 m for a single building); the
 *  spread of day-of GPS fixes when a user is genuinely AT a place is
 *  much larger — indoor multipath, building corners, walking in and
 *  out. Production data shows day-of clusters routinely sit 100–200 m
 *  from a known place's centroid, so a place we are confident about
 *  gets a 100 m σ floor and the Gaussian doesn't collapse to ~0 for
 *  ordinary noise distances.
 *
 *  `SIGMA_FLOOR_MIN_M` — the floor for a place seen on a single day.
 *  It has earned no benefit of the doubt: a tight σ so it cannot
 *  capture a stay that merely falls in the same neighbourhood. With
 *  only the wide floor, the −8 posterior floor let even a once-visited
 *  place reach ~4σ ≈ 400 m and stamp its one-off mined label onto
 *  unrelated stays hundreds of metres away. */
const SIGMA_FLOOR_MAX_M = 100;
const SIGMA_FLOOR_MIN_M = 40;

/** e-folding constant (in distinct visit-days) for how fast a place's
 *  σ floor climbs from MIN toward MAX. At `1 + TAU` visit-days the
 *  floor has closed ~63 % of the MIN→MAX gap. 10 days ⇒ a place
 *  visited a couple of weeks' worth of days is most of the way to the
 *  full established tolerance; a one-off sits at the minimum. */
const SIGMA_ESTABLISH_TAU_DAYS = 10;

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
	// The GPS-noise σ floor is earned, continuously: a place's tolerance
	// climbs from MIN toward MAX as distinct visit-days accumulate, with
	// no hard "established" step. A one-off place sits at the minimum
	// and cannot reach far past its own footprint; a place visited over
	// many days converges on the full tolerance.
	const establishedness = 1 - Math.exp(-Math.max(0, candidate.uniqueDays - 1) / SIGMA_ESTABLISH_TAU_DAYS);
	const sigmaFloor = SIGMA_FLOOR_MIN_M + (SIGMA_FLOOR_MAX_M - SIGMA_FLOOR_MIN_M) * establishedness;
	const sigma = Math.max(sigmaFloor, candidate.radiusM);
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
