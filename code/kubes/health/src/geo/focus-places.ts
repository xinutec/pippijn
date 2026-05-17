/**
 * Focus-place detection from raw GPS history.
 *
 * Pure module — no DB, no I/O. Used by:
 *  - the local CLI (src/cli/find-focus-places.ts) for ad-hoc analysis
 *  - the cron (src/cli/refresh-focus-places.ts) to populate focus_places
 *  - tests
 *
 * Pipeline:
 *   1. detectStays — windows where all points cluster within STAY_RADIUS_M of
 *      their median centroid for ≥ STAY_MIN_DURATION_SEC. No max-gap rule;
 *      the radius check breaks the window when the phone moves elsewhere.
 *   2. clusterStays — greedy, plus a post-merge pass to combine drifting
 *      cluster fragments. Centroid is an accuracy-weighted mean of fixes.
 *   3. classifyCluster — assign a coarse label (home/work/hotel/frequent/...)
 *      from time-of-day + date-span heuristics. Labels are advisory.
 */

import { haversineMeters } from "./place-snap.js";

export const STAY_RADIUS_M = 100;
export const STAY_MIN_DURATION_SEC = 10 * 60; // 10 min — short enough to catch cafes
export const ACCURACY_FILTER_M = 200;
export const CLUSTER_RADIUS_M = 150;
/** A fix reported more accurate than this is treated as exactly this
 *  accurate — GPS does not realistically do better, and it bounds the
 *  1/σ² weight against a near-zero denominator. */
export const ACCURACY_FLOOR_M = 5;
/** Assumed σ for a fix whose device did not report an accuracy. */
export const ACCURACY_DEFAULT_M = 50;

export interface RawPoint {
	ts: number;
	lat: number;
	lon: number;
	accuracy: number | null;
}

export interface Stay {
	startTs: number;
	endTs: number;
	centroidLat: number;
	centroidLon: number;
	pointCount: number;
	durationSec: number;
	/** Σ of the inverse-variance weights of this stay's fixes. The
	 *  cluster centroid combines stay centroids by this. */
	weight: number;
}

export interface Cluster {
	id: number;
	centroidLat: number;
	centroidLon: number;
	stays: Stay[];
	totalDwellSec: number;
	/** Σ of member stays' `weight` — the denominator of the
	 *  accuracy-weighted cluster centroid. */
	totalWeight: number;
}

export type ClusterLabel = "home" | "work" | "hotel" | "frequent" | "one-off" | "other";
export type DisplayName = "Home" | "Work" | "Stay";

export interface ClusterClassification {
	label: ClusterLabel;
	reason: string;
}

// --- Stay detection ---

function median(arr: number[]): number {
	const sorted = [...arr].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function medianCentroid(points: RawPoint[]): { lat: number; lon: number } {
	return { lat: median(points.map((p) => p.lat)), lon: median(points.map((p) => p.lon)) };
}

function maxDistFromCentroid(points: RawPoint[], lat: number, lon: number): number {
	let max = 0;
	for (const p of points) {
		const d = haversineMeters(lat, lon, p.lat, p.lon);
		if (d > max) max = d;
	}
	return max;
}

/** Inverse-variance weight for a fix — a more accurate fix counts far
 *  more. Reported accuracy is the GPS 1σ radius, so weight ∝ 1/σ². A
 *  null (unreported) accuracy gets a conservative default σ. */
export function fixWeight(accuracy: number | null): number {
	const sigma = Math.max(accuracy ?? ACCURACY_DEFAULT_M, ACCURACY_FLOOR_M);
	return 1 / (sigma * sigma);
}

/** Accuracy-weighted mean position of a non-empty set of fixes, plus
 *  the total weight Σw. Precise fixes dominate; a noisy crowd barely
 *  shifts the result. Clusters combine stay centroids by Σw, so the
 *  per-stay total travels with the centroid. */
export function weightedCentroid(points: RawPoint[]): { lat: number; lon: number; weight: number } {
	let sw = 0;
	let sLat = 0;
	let sLon = 0;
	for (const p of points) {
		const w = fixWeight(p.accuracy);
		sw += w;
		sLat += w * p.lat;
		sLon += w * p.lon;
	}
	return { lat: sLat / sw, lon: sLon / sw, weight: sw };
}

export function detectStays(points: RawPoint[]): Stay[] {
	const stays: Stay[] = [];
	let i = 0;
	while (i < points.length) {
		// Greedily extend window [i..j) while all points are within STAY_RADIUS_M
		// of their median centroid. The radius check is what eventually breaks
		// the window when the phone moves elsewhere.
		let j = i + 1;
		let bestJ = i + 1;
		while (j < points.length) {
			const slice = points.slice(i, j + 1);
			const c = medianCentroid(slice);
			if (maxDistFromCentroid(slice, c.lat, c.lon) > STAY_RADIUS_M) break;
			j++;
			bestJ = j;
		}
		const slice = points.slice(i, bestJ);
		if (slice.length >= 2) {
			const c = weightedCentroid(slice);
			const duration = slice[slice.length - 1].ts - slice[0].ts;
			if (duration >= STAY_MIN_DURATION_SEC) {
				stays.push({
					startTs: slice[0].ts,
					endTs: slice[slice.length - 1].ts,
					centroidLat: c.lat,
					centroidLon: c.lon,
					pointCount: slice.length,
					durationSec: duration,
					weight: c.weight,
				});
				i = bestJ;
				continue;
			}
		}
		i = i + 1; // not a stay; advance one and try again
	}
	return stays;
}

// --- Clustering ---

export function clusterStays(stays: Stay[]): Cluster[] {
	const clusters: Cluster[] = [];
	for (const stay of stays) {
		let best: Cluster | null = null;
		let bestDist = Infinity;
		for (const c of clusters) {
			const d = haversineMeters(c.centroidLat, c.centroidLon, stay.centroidLat, stay.centroidLon);
			if (d < bestDist && d <= CLUSTER_RADIUS_M) {
				best = c;
				bestDist = d;
			}
		}
		if (best) {
			addStayToCluster(best, stay);
		} else {
			clusters.push({
				id: clusters.length + 1,
				centroidLat: stay.centroidLat,
				centroidLon: stay.centroidLon,
				stays: [stay],
				totalDwellSec: stay.durationSec,
				totalWeight: stay.weight,
			});
		}
	}
	// Greedy clustering can create separate clusters whose centroids drift to
	// within range after the fact. Merge any pair within CLUSTER_RADIUS_M
	// repeatedly until no merges happen.
	let merged = true;
	while (merged) {
		merged = false;
		outer: for (let i = 0; i < clusters.length; i++) {
			for (let j = i + 1; j < clusters.length; j++) {
				const d = haversineMeters(
					clusters[i].centroidLat,
					clusters[i].centroidLon,
					clusters[j].centroidLat,
					clusters[j].centroidLon,
				);
				if (d <= CLUSTER_RADIUS_M) {
					mergeCluster(clusters[i], clusters[j]);
					clusters.splice(j, 1);
					merged = true;
					break outer;
				}
			}
		}
	}
	return clusters;
}

function addStayToCluster(c: Cluster, stay: Stay): void {
	c.stays.push(stay);
	c.totalDwellSec += stay.durationSec;
	const oldWeight = c.totalWeight;
	c.totalWeight += stay.weight;
	c.centroidLat = (c.centroidLat * oldWeight + stay.centroidLat * stay.weight) / c.totalWeight;
	c.centroidLon = (c.centroidLon * oldWeight + stay.centroidLon * stay.weight) / c.totalWeight;
}

function mergeCluster(into: Cluster, other: Cluster): void {
	const totalW = into.totalWeight + other.totalWeight;
	into.centroidLat = (into.centroidLat * into.totalWeight + other.centroidLat * other.totalWeight) / totalW;
	into.centroidLon = (into.centroidLon * into.totalWeight + other.centroidLon * other.totalWeight) / totalW;
	into.totalWeight = totalW;
	into.totalDwellSec += other.totalDwellSec;
	for (const s of other.stays) into.stays.push(s);
}

// --- Classification ---

/**
 * Hour-of-day at the cluster's location, using rough solar time from longitude.
 * Avoids misclassifying CA hotels as "daytime" when the user's home tz is GMT.
 * Accurate enough for "is it overnight or workday" without a tz-lookup library.
 */
export function localSolarHour(ts: number, lon: number): number {
	const d = new Date(ts * 1000);
	const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
	const local = utcMinutes + (lon / 15) * 60;
	const wrapped = ((local % (24 * 60)) + 24 * 60) % (24 * 60);
	return Math.floor(wrapped / 60);
}

/** Day-of-week in the cluster's local solar time. 0 = Monday, 6 = Sunday. */
export function localSolarDayOfWeek(ts: number, lon: number): number {
	// Shift the timestamp by lon-derived solar offset, then take UTC day.
	const offsetSec = Math.round((lon / 15) * 3600);
	const localTs = ts + offsetSec;
	const d = new Date(localTs * 1000);
	// getUTCDay returns 0=Sun ... 6=Sat; shift to 0=Mon ... 6=Sun
	return (d.getUTCDay() + 6) % 7;
}

function ymdLocal(ts: number, lon: number): string {
	const offsetSec = Math.round((lon / 15) * 3600);
	const d = new Date((ts + offsetSec) * 1000);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Sum of stay durations where the stay covers any of 02:00–06:00 in the
 *  cluster's local solar time. This is the "you sleep here sometimes"
 *  signal: robust to varied sleep schedules (22-09 or 02-10), robust to
 *  long café visits (which don't cross deep-night). A 5-h cafe at 14:00
 *  contributes nothing; a 6-h overnight stay 22:00-04:00 contributes 6 h. */
const DEEP_NIGHT_START_HOUR = 2;
const DEEP_NIGHT_END_HOUR = 6;

function stayCoversDeepNight(s: Stay, lon: number): boolean {
	const stepSec = 30 * 60;
	for (let t = s.startTs; t <= s.endTs; t += stepSec) {
		const h = localSolarHour(t, lon);
		if (h >= DEEP_NIGHT_START_HOUR && h < DEEP_NIGHT_END_HOUR) return true;
	}
	return false;
}

export function sleepHoursOf(cluster: Cluster): number {
	let sec = 0;
	for (const s of cluster.stays) {
		if (stayCoversDeepNight(s, cluster.centroidLon)) sec += s.durationSec;
	}
	return sec / 3600;
}

/** A Fitbit sleep record's wall-clock window, expressed as unix
 *  seconds. Constructed from the `sleep` table by the caller; this
 *  module stays pure. */
export interface FitbitSleepWindow {
	startTs: number;
	endTs: number;
}

/** Sum, in hours, of the actual overlap between each stay and any
 *  Fitbit sleep window. Strictly more accurate than `sleepHoursOf`
 *  when Fitbit data is available:
 *
 *    - Catches shifted-sleep nights (04:00–12:00) that the local
 *      02:00–06:00 deep-night heuristic would miss.
 *    - Excludes "I sat at home from 22:00 to 04:00 watching TV"
 *      nights — if Fitbit didn't record sleep, those hours don't
 *      count.
 *
 *  Returns 0 when `sleepWindows` is empty (user without Fitbit, or
 *  no sleep data in the relevant period) — caller can fall back to
 *  `sleepHoursOf` in that case. */
export function sleepHoursFromFitbit(stays: readonly Stay[], sleepWindows: readonly FitbitSleepWindow[]): number {
	if (sleepWindows.length === 0) return 0;
	let totalSec = 0;
	for (const s of stays) {
		for (const w of sleepWindows) {
			const overlapStart = Math.max(s.startTs, w.startTs);
			const overlapEnd = Math.min(s.endTs, w.endTs);
			if (overlapEnd > overlapStart) totalSec += overlapEnd - overlapStart;
		}
	}
	return totalSec / 3600;
}

function sumHourBucket(stays: Stay[], lon: number, hStart: number, hEnd: number): number {
	let hours = 0;
	const stepSec = 30 * 60;
	for (const s of stays) {
		for (let t = s.startTs; t <= s.endTs; t += stepSec) {
			const h = localSolarHour(t, lon);
			if (h >= hStart && h < hEnd) hours += stepSec / 3600;
		}
	}
	return hours;
}

function weekdayDaytimeHours(stays: Stay[], lon: number): number {
	let hours = 0;
	const stepSec = 30 * 60;
	for (const s of stays) {
		for (let t = s.startTs; t <= s.endTs; t += stepSec) {
			const dow = localSolarDayOfWeek(t, lon);
			const h = localSolarHour(t, lon);
			if (dow <= 4 && h >= 9 && h < 17) hours += stepSec / 3600;
		}
	}
	return hours;
}

export function uniqueDayCount(stays: Stay[], lon: number): number {
	return new Set(stays.map((s) => ymdLocal(s.startTs, lon))).size;
}

export function classifyCluster(c: Cluster): ClusterClassification {
	const sortedStays = [...c.stays].sort((a, b) => a.startTs - b.startTs);
	const firstTs = sortedStays[0].startTs;
	const lastTs = sortedStays[sortedStays.length - 1].endTs;
	const dateSpanDays = (lastTs - firstTs) / 86400;
	const uniqueDays = uniqueDayCount(c.stays, c.centroidLon);
	const totalHours = c.totalDwellSec / 3600;
	const overnightHours = sumHourBucket(c.stays, c.centroidLon, 0, 6);
	const wkdayDaytime = weekdayDaytimeHours(c.stays, c.centroidLon);
	const overnightFrac = overnightHours / Math.max(totalHours, 1);
	const wkdayDaytimeFrac = wkdayDaytime / Math.max(totalHours, 1);

	if (dateSpanDays >= 30 && uniqueDays >= 20 && overnightFrac >= 0.25) {
		return {
			label: "home",
			reason: `${(overnightFrac * 100).toFixed(0)}% overnight, ${uniqueDays}d over ${Math.round(dateSpanDays)}d`,
		};
	}
	// Long-running work (regular office)
	if (dateSpanDays >= 28 && uniqueDays >= 10 && wkdayDaytimeFrac >= 0.35 && overnightFrac < 0.1) {
		return { label: "work", reason: `${(wkdayDaytimeFrac * 100).toFixed(0)}% weekday-daytime, ${uniqueDays}d` };
	}
	// Trip-work (Google MTV-style — weekday daytime presence during a trip).
	// Requires a contained window so we don't swallow a "frequent" recurring spot.
	if (dateSpanDays >= 5 && dateSpanDays <= 21 && uniqueDays >= 5 && wkdayDaytimeFrac >= 0.3 && overnightFrac < 0.15) {
		return {
			label: "work",
			reason: `${(wkdayDaytimeFrac * 100).toFixed(0)}% weekday-daytime in a ${Math.round(dateSpanDays)}-day window`,
		};
	}
	if (dateSpanDays <= 21 && overnightFrac >= 0.15) {
		return {
			label: "hotel",
			reason: `${(overnightFrac * 100).toFixed(0)}% overnight, ${Math.round(dateSpanDays)}-day window`,
		};
	}
	if (uniqueDays >= 5 && dateSpanDays >= 30) {
		return { label: "frequent", reason: `${uniqueDays} visits over ${Math.round(dateSpanDays)}d` };
	}
	if (uniqueDays <= 2) {
		return { label: "one-off", reason: `${uniqueDays} visit(s)` };
	}
	return { label: "other", reason: `${uniqueDays} days, ${Math.round(dateSpanDays)}d span` };
}

// --- Display names: pick a "Home" and a "Work" cluster from the set ---

/**
 * Assign at most one "Home" and one "Work" label across a user's clusters,
 * derived purely from time-of-day patterns. Returns a map cluster.id → name.
 *
 * - Home: cluster with the most overnight (00-06 local solar) hours, given
 *   it has at least 20 unique days of presence across at least 30 days span.
 *   Singular — only one Home is assigned, even if two clusters look home-like.
 * - Work: cluster (excluding the Home pick) with the most weekday-daytime
 *   (Mon-Fri 09-17) hours, given at least 5 weekday-daytime hours overall.
 *
 * Other clusters get no display_name; the timeline falls back to OSM.
 */
export function assignDisplayNames(clusters: Cluster[]): Map<number, string> {
	const names = new Map<number, string>();

	// Home: strict — wide span + many unique days + significant long-stay history.
	// Picks at most one cluster (the strongest "where I usually sleep").
	const homeCandidates = clusters
		.map((c) => {
			const sorted = [...c.stays].sort((a, b) => a.startTs - b.startTs);
			const dateSpanDays = (sorted[sorted.length - 1].endTs - sorted[0].startTs) / 86400;
			const uniqueDays = uniqueDayCount(c.stays, c.centroidLon);
			const sleepHours = sleepHoursOf(c);
			return { cluster: c, dateSpanDays, uniqueDays, sleepHours };
		})
		.filter((x) => x.dateSpanDays >= 30 && x.uniqueDays >= 20 && x.sleepHours >= 30)
		.sort((a, b) => b.sleepHours - a.sleepHours);

	const homeId = homeCandidates[0]?.cluster.id ?? null;
	if (homeId !== null) names.set(homeId, "Home");

	// Work: significant weekday-daytime hours (≥20 — real workplaces vastly
	// exceed this; a cafe visited 8× over 2 months gives ~6 h, doesn't qualify).
	const workCandidates = clusters
		.filter((c) => c.id !== homeId)
		.map((c) => ({ cluster: c, hours: weekdayDaytimeHours(c.stays, c.centroidLon) }))
		.filter((x) => x.hours >= 20)
		.sort((a, b) => b.hours - a.hours);

	const workId = workCandidates[0]?.cluster.id ?? null;
	if (workId !== null) names.set(workId, "Work");

	// Stay: clusters with deep-night presence (you sleep here sometimes) but
	// not enough history to qualify as Home. Parents' flats, friends'
	// apartments, multi-night hotels. The stay-covers-deep-night signal
	// keeps long café visits out of this tier.
	for (const c of clusters) {
		if (names.has(c.id)) continue;
		const sleepHours = sleepHoursOf(c);
		const uniqueDays = uniqueDayCount(c.stays, c.centroidLon);
		if (sleepHours >= 5 && uniqueDays >= 2) {
			names.set(c.id, "Stay");
		}
	}

	return names;
}

// --- High-level pipeline ---

/**
 * Pick the dominant amenity name from a vote tally across cluster visits.
 *
 * Inputs:
 *   - `votes`: map of amenity name → total weight (typically dwell seconds).
 *     A 2-hour stay at one venue counts more than a 5-min stop next door.
 *   - `opts.minWeight`: the total vote weight must reach this floor before
 *     we'll commit to a winner. Prevents picking a name from a single
 *     short-visit cluster with no real evidence.
 *   - `opts.minFraction`: the winner's share of the total must exceed this.
 *     A close vote (cafe A 52%, cafe B 48%) returns null so the runtime
 *     OSM picker stays in charge.
 *
 * Returns null when the evidence is insufficient (sparse, contested, or
 * empty). Caller treats null as "fall back to per-visit OSM lookup."
 */
export function pickWinningAmenity(
	votes: Map<string, number>,
	opts: { minWeight: number; minFraction: number },
): string | null {
	if (votes.size === 0) return null;
	let total = 0;
	let winner = "";
	let winnerWeight = 0;
	for (const [name, w] of votes) {
		total += w;
		if (w > winnerWeight) {
			winnerWeight = w;
			winner = name;
		}
	}
	if (total < opts.minWeight) return null;
	if (winnerWeight / total < opts.minFraction) return null;
	return winner;
}

export interface PlaceDetectionResult {
	stays: Stay[];
	clusters: Cluster[];
}

/**
 * One-call pipeline: filter low-accuracy points, detect stays, cluster.
 * Caller supplies raw points (typically loaded from location_history).
 */
export function detectFocusPlaces(points: RawPoint[]): PlaceDetectionResult {
	const filtered = points.filter((p) => p.accuracy === null || p.accuracy <= ACCURACY_FILTER_M);
	const stays = detectStays(filtered);
	const clusters = clusterStays(stays);
	clusters.sort((a, b) => b.totalDwellSec - a.totalDwellSec);
	return { stays, clusters };
}
