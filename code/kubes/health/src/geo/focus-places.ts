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
 *      cluster fragments. Centroid is dwell-weighted average.
 *   3. classifyCluster — assign a coarse label (home/work/hotel/frequent/...)
 *      from time-of-day + date-span heuristics. Labels are advisory.
 */

import { haversineMeters } from "./place-snap.js";

export const STAY_RADIUS_M = 100;
export const STAY_MIN_DURATION_SEC = 10 * 60; // 10 min — short enough to catch cafes
export const ACCURACY_FILTER_M = 200;
export const CLUSTER_RADIUS_M = 150;

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
}

export interface Cluster {
	id: number;
	centroidLat: number;
	centroidLon: number;
	stays: Stay[];
	totalDwellSec: number;
}

export type ClusterLabel = "home" | "work" | "hotel" | "frequent" | "one-off" | "other";

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
			const c = medianCentroid(slice);
			const duration = slice[slice.length - 1].ts - slice[0].ts;
			if (duration >= STAY_MIN_DURATION_SEC) {
				stays.push({
					startTs: slice[0].ts,
					endTs: slice[slice.length - 1].ts,
					centroidLat: c.lat,
					centroidLon: c.lon,
					pointCount: slice.length,
					durationSec: duration,
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
	const oldWeight = c.totalDwellSec - stay.durationSec;
	c.centroidLat = (c.centroidLat * oldWeight + stay.centroidLat * stay.durationSec) / c.totalDwellSec;
	c.centroidLon = (c.centroidLon * oldWeight + stay.centroidLon * stay.durationSec) / c.totalDwellSec;
}

function mergeCluster(into: Cluster, other: Cluster): void {
	const totalAfter = into.totalDwellSec + other.totalDwellSec;
	into.centroidLat = (into.centroidLat * into.totalDwellSec + other.centroidLat * other.totalDwellSec) / totalAfter;
	into.centroidLon = (into.centroidLon * into.totalDwellSec + other.centroidLon * other.totalDwellSec) / totalAfter;
	into.totalDwellSec = totalAfter;
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

	const homeCandidates = clusters
		.map((c) => {
			const sorted = [...c.stays].sort((a, b) => a.startTs - b.startTs);
			const dateSpanDays = (sorted[sorted.length - 1].endTs - sorted[0].startTs) / 86400;
			const uniqueDays = uniqueDayCount(c.stays, c.centroidLon);
			const overnightHours = sumHourBucket(c.stays, c.centroidLon, 0, 6);
			return { cluster: c, dateSpanDays, uniqueDays, overnightHours };
		})
		.filter((x) => x.dateSpanDays >= 30 && x.uniqueDays >= 20 && x.overnightHours >= 10)
		.sort((a, b) => b.overnightHours - a.overnightHours);

	const homeId = homeCandidates[0]?.cluster.id ?? null;
	if (homeId !== null) names.set(homeId, "Home");

	const workCandidates = clusters
		.filter((c) => c.id !== homeId)
		.map((c) => ({ cluster: c, hours: weekdayDaytimeHours(c.stays, c.centroidLon) }))
		.filter((x) => x.hours >= 5)
		.sort((a, b) => b.hours - a.hours);

	const workId = workCandidates[0]?.cluster.id ?? null;
	if (workId !== null) names.set(workId, "Work");

	return names;
}

// --- High-level pipeline ---

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
