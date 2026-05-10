/**
 * Transport mode classification from Kalman-filtered GPS tracks.
 *
 * Splits a track into time windows, calculates movement features per window,
 * scores each transport mode, then merges adjacent windows with the same mode
 * into segments. Smooths transitions to avoid impossible mode flipping.
 */

import type { FilteredPoint } from "./kalman.js";

export type TransportMode = "stationary" | "walking" | "cycling" | "driving" | "train" | "plane";

export interface TrackSegment {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	confidence: number; // 0-1
	avgSpeed: number; // km/h
	maxSpeed: number;
	linearity: number; // 0-1, ratio of straight-line to path distance
	pointCount: number;
}

interface WindowFeatures {
	startTs: number;
	endTs: number;
	centroidLat: number;
	centroidLon: number;
	medianSpeed: number;
	maxSpeed: number;
	speedVariance: number;
	headingChangeRate: number; // degrees per second
	linearity: number;
	accelerationBursts: number; // count of speed changes > 5 km/h/s
	stopFraction: number; // fraction of points with speed < 1 km/h
	netDisplacement: number; // meters between first and last point
	boundingRadius: number; // meters, max distance from centroid
	pointCount: number;
}

// --- Feature extraction ---

function median(arr: number[]): number {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function variance(arr: number[]): number {
	if (arr.length < 2) return 0;
	const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
	return arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (arr.length - 1);
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371000;
	const dLat = (lat2 - lat1) * (Math.PI / 180);
	const dLon = (lon2 - lon1) * (Math.PI / 180);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractFeatures(points: FilteredPoint[], windowSec: number): WindowFeatures[] {
	if (points.length < 2) return [];

	const windows: WindowFeatures[] = [];
	let windowStart = 0;

	while (windowStart < points.length) {
		const startTs = points[windowStart].ts;
		const endTs = startTs + windowSec;

		// Collect points in this window
		let windowEnd = windowStart;
		while (windowEnd < points.length && points[windowEnd].ts < endTs) {
			windowEnd++;
		}

		const windowPoints = points.slice(windowStart, windowEnd);
		if (windowPoints.length < 2) {
			windowStart = windowEnd;
			continue;
		}

		const speeds = windowPoints.map((p) => p.speed_kmh);
		const bearings = windowPoints.map((p) => p.bearing);

		// Heading change rate (degrees per second)
		let totalHeadingChange = 0;
		for (let i = 1; i < bearings.length; i++) {
			let diff = Math.abs(bearings[i] - bearings[i - 1]);
			if (diff > 180) diff = 360 - diff;
			totalHeadingChange += diff;
		}
		const duration = windowPoints[windowPoints.length - 1].ts - windowPoints[0].ts || 1;
		const headingChangeRate = totalHeadingChange / duration;

		// Path linearity: straight-line distance / total path distance
		const straightLine = haversineMeters(
			windowPoints[0].lat,
			windowPoints[0].lon,
			windowPoints[windowPoints.length - 1].lat,
			windowPoints[windowPoints.length - 1].lon,
		);
		let pathDistance = 0;
		for (let i = 1; i < windowPoints.length; i++) {
			pathDistance += haversineMeters(
				windowPoints[i - 1].lat,
				windowPoints[i - 1].lon,
				windowPoints[i].lat,
				windowPoints[i].lon,
			);
		}
		const linearity = pathDistance > 0 ? Math.min(straightLine / pathDistance, 1) : 0;

		// Acceleration bursts: speed changes > 5 km/h between consecutive points
		let accelBursts = 0;
		for (let i = 1; i < windowPoints.length; i++) {
			const dt = windowPoints[i].ts - windowPoints[i - 1].ts || 1;
			const accel = Math.abs(speeds[i] - speeds[i - 1]) / dt;
			if (accel > 5 / 3.6) accelBursts++; // 5 km/h/s
		}

		// Stop fraction
		const stops = speeds.filter((s) => s < 1).length;

		// Net displacement: straight-line distance from start to end
		const netDisplacement = straightLine;

		// Bounding radius: max distance from centroid
		const centroidLat = windowPoints.reduce((s, p) => s + p.lat, 0) / windowPoints.length;
		const centroidLon = windowPoints.reduce((s, p) => s + p.lon, 0) / windowPoints.length;
		let maxDist = 0;
		for (const p of windowPoints) {
			const d = haversineMeters(centroidLat, centroidLon, p.lat, p.lon);
			if (d > maxDist) maxDist = d;
		}
		const boundingRadius = maxDist;

		windows.push({
			startTs: windowPoints[0].ts,
			endTs: windowPoints[windowPoints.length - 1].ts,
			centroidLat,
			centroidLon,
			medianSpeed: median(speeds),
			maxSpeed: Math.max(...speeds),
			speedVariance: variance(speeds),
			headingChangeRate,
			linearity,
			accelerationBursts: accelBursts,
			stopFraction: stops / speeds.length,
			netDisplacement,
			boundingRadius,
			pointCount: windowPoints.length,
		});

		windowStart = windowEnd;
	}

	return windows;
}

// --- Mode scoring ---

interface ModeScore {
	mode: TransportMode;
	score: number;
}

function scoreWindow(f: WindowFeatures): ModeScore[] {
	const scores: ModeScore[] = [
		{ mode: "stationary", score: scoreStationary(f) },
		{ mode: "walking", score: scoreWalking(f) },
		{ mode: "cycling", score: scoreCycling(f) },
		{ mode: "driving", score: scoreDriving(f) },
		{ mode: "train", score: scoreTrain(f) },
		{ mode: "plane", score: scorePlane(f) },
	];
	return scores.sort((a, b) => b.score - a.score);
}

// Gaussian-like scoring: how well does the value match the expected range?
function rangeScore(value: number, ideal: number, tolerance: number): number {
	return Math.exp(-0.5 * ((value - ideal) / tolerance) ** 2);
}

function scoreStationary(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 0, 1.5);
	score *= 1 + f.stopFraction; // bonus for lots of stops

	// Key insight: if all points are within a small radius, it's stationary
	// regardless of GPS-noise-induced speed. Catches stone-throwing, fidgeting, etc.
	if (f.boundingRadius < 30) score *= 3;
	if (f.boundingRadius < 15) score *= 3;
	if (f.netDisplacement < 20) score *= 2;

	// Hidden-movement penalty: stationary should mean *consistently* low speed
	// AND no significant displacement. A high max speed combined with a real
	// net displacement (>200m) means the user actually moved during the window
	// — typically a train segment that surfaced briefly between underground
	// stretches. Without this, sparse-GPS train rides hide inside a stationary
	// segment whose median speed is dominated by the surrounding platform fixes.
	// A GPS noise spike (high max but no displacement) doesn't trigger this.
	if (f.maxSpeed > 20 && f.netDisplacement > 200) score *= 0.1;

	return score;
}

function scoreWalking(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 4, 3); // 1-7 km/h
	score *= rangeScore(f.linearity, 0.5, 0.4); // moderate linearity
	score *= 1 + f.headingChangeRate * 0.5; // walking has more turns
	if (f.maxSpeed > 15) score *= 0.1; // unlikely if max speed is high

	// If you don't actually go anywhere, it's not walking
	if (f.boundingRadius < 30) score *= 0.1;
	if (f.netDisplacement < 30) score *= 0.2;

	return score;
}

function scoreCycling(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 18, 8); // 10-26 km/h
	score *= rangeScore(f.linearity, 0.7, 0.3);
	score *= rangeScore(f.speedVariance, 15, 20); // moderate variance
	if (f.maxSpeed > 50) score *= 0.1;
	return score;
}

function scoreDriving(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 60, 35); // 25-95 km/h
	score *= 1 + f.accelerationBursts * 0.3; // cars accelerate/brake
	score *= rangeScore(f.linearity, 0.7, 0.3);
	if (f.medianSpeed < 10) score *= 0.1;
	return score;
}

function scoreTrain(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 120, 60); // 60-180 km/h
	score *= rangeScore(f.linearity, 0.95, 0.1); // very linear
	score *= rangeScore(f.speedVariance, 5, 15); // very consistent speed
	score *= rangeScore(f.headingChangeRate, 0.5, 2); // minimal turning
	if (f.medianSpeed < 30) score *= 0.1;
	return score;
}

function scorePlane(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 500, 300); // 200-800 km/h
	score *= rangeScore(f.linearity, 0.99, 0.05); // extremely linear
	score *= rangeScore(f.speedVariance, 2, 10); // extremely consistent
	if (f.medianSpeed < 150) score *= 0.01;
	return score;
}

// --- Segment merging ---

/** A new stationary window joining a stationary segment forces a split if its
 * centroid is more than this far from the segment's running centroid. Catches
 * "you were stationary at A, then stationary at B, 280m away" — two stays,
 * not one. Threshold matches STAY_RADIUS_M used elsewhere. */
const STATIONARY_SPLIT_DIST_M = 100;

function mergeWindows(windows: WindowFeatures[], scores: ModeScore[][]): TrackSegment[] {
	if (windows.length === 0) return [];

	const segments: TrackSegment[] = [];
	let currentMode = scores[0][0].mode;
	let _currentConfidence = scores[0][0].score;
	let segStart = 0;

	function flushSegment(endIdx: number): void {
		const segWindows = windows.slice(segStart, endIdx);
		const segScores = scores.slice(segStart, endIdx);
		const allSpeeds = segWindows.map((w) => w.medianSpeed);
		const avgConfidence = segScores.reduce((sum, s) => sum + s[0].score, 0) / segScores.length;
		const avgLinearity = segWindows.reduce((sum, w) => sum + w.linearity, 0) / segWindows.length;

		segments.push({
			startTs: segWindows[0].startTs,
			endTs: segWindows[segWindows.length - 1].endTs,
			mode: currentMode,
			confidence: Math.round(avgConfidence * 100) / 100,
			avgSpeed: Math.round(median(allSpeeds) * 10) / 10,
			maxSpeed: Math.round(Math.max(...segWindows.map((w) => w.maxSpeed)) * 10) / 10,
			linearity: Math.round(avgLinearity * 100) / 100,
			pointCount: segWindows.reduce((sum, w) => sum + w.pointCount, 0),
		});
	}

	for (let i = 1; i <= windows.length; i++) {
		const newMode = i < windows.length ? scores[i][0].mode : null;

		// Force-split a stationary segment if the new stationary window is far
		// from the segment's running centroid. Same-mode windows otherwise merge
		// regardless of location, which would collapse two distinct stays.
		let locationSplit = false;
		if (i < windows.length && currentMode === "stationary" && newMode === "stationary") {
			const segWindows = windows.slice(segStart, i);
			const totalPts = segWindows.reduce((s, w) => s + w.pointCount, 0);
			const cLat = segWindows.reduce((s, w) => s + w.centroidLat * w.pointCount, 0) / totalPts;
			const cLon = segWindows.reduce((s, w) => s + w.centroidLon * w.pointCount, 0) / totalPts;
			const next = windows[i];
			const dist = haversineMeters(cLat, cLon, next.centroidLat, next.centroidLon);
			if (dist > STATIONARY_SPLIT_DIST_M) locationSplit = true;
		}

		if (newMode !== currentMode || locationSplit || i === windows.length) {
			flushSegment(i);
			if (i < windows.length) {
				currentMode = scores[i][0].mode;
				_currentConfidence = scores[i][0].score;
				segStart = i;
			}
		}
	}

	return segments;
}

/**
 * Remove segments shorter than minDuration by merging them into neighbors.
 * A 10-second "driving" segment between two "walking" segments is noise.
 */
function smoothSegments(segments: TrackSegment[], minDurationSec: number): TrackSegment[] {
	if (segments.length <= 1) return segments;

	const result: TrackSegment[] = [segments[0]];

	for (let i = 1; i < segments.length; i++) {
		const seg = segments[i];
		const duration = seg.endTs - seg.startTs;

		if (duration < minDurationSec && result.length > 0) {
			// Too short — merge into previous segment
			const prev = result[result.length - 1];
			prev.endTs = seg.endTs;
			prev.pointCount += seg.pointCount;
			prev.maxSpeed = Math.max(prev.maxSpeed, seg.maxSpeed);
		} else {
			result.push(seg);
		}
	}

	return result;
}

// --- Stay detection (sparse-data fallback) ---

const STAY_MIN_DURATION_SEC = 15 * 60; // 15 minutes
const STAY_RADIUS_M = 150; // robust radius — accommodates indoor GPS drift

interface StayPoint {
	ts: number;
	lat: number;
	lon: number;
}

/**
 * Find stationary "stays" in time periods not covered by any classified
 * segment. The window-based classifier silently drops windows with < 2
 * points — which is exactly the failure mode for "indoors at one place"
 * tracking, where the phone reports sparse, low-accuracy GPS. This pass
 * walks the gaps between (and around) the classified segments, and emits
 * a stationary segment for any gap ≥ 15 min where the available points
 * cluster within 150 m of the median centroid (with outliers dropped).
 */
export function findStays(points: StayPoint[], existing: TrackSegment[]): TrackSegment[] {
	if (points.length === 0) return [];

	const sorted = [...existing].sort((a, b) => a.startTs - b.startTs);
	const gaps: Array<{ start: number; end: number }> = [];

	if (sorted.length === 0) {
		gaps.push({ start: points[0].ts, end: points[points.length - 1].ts });
	} else {
		const firstPointTs = points[0].ts;
		if (sorted[0].startTs - firstPointTs >= STAY_MIN_DURATION_SEC) {
			gaps.push({ start: firstPointTs, end: sorted[0].startTs });
		}
		for (let i = 0; i < sorted.length - 1; i++) {
			const gapStart = sorted[i].endTs;
			const gapEnd = sorted[i + 1].startTs;
			if (gapEnd - gapStart >= STAY_MIN_DURATION_SEC) {
				gaps.push({ start: gapStart, end: gapEnd });
			}
		}
		const lastPointTs = points[points.length - 1].ts;
		const lastSegEnd = sorted[sorted.length - 1].endTs;
		if (lastPointTs - lastSegEnd >= STAY_MIN_DURATION_SEC) {
			gaps.push({ start: lastSegEnd, end: lastPointTs });
		}
	}

	const stays: TrackSegment[] = [];
	for (const gap of gaps) {
		const inGap = points.filter((p) => p.ts >= gap.start && p.ts <= gap.end);
		if (inGap.length < 2) continue;

		// Robust cluster center: median of each axis (resilient to outlier points,
		// which are common when GPS accuracy degrades indoors).
		const lats = inGap.map((p) => p.lat).sort((a, b) => a - b);
		const lons = inGap.map((p) => p.lon).sort((a, b) => a - b);
		const cLat = lats[Math.floor(lats.length / 2)];
		const cLon = lons[Math.floor(lons.length / 2)];

		// Drop points outside the cluster radius (high-uncertainty GPS spikes).
		const inCluster = inGap.filter((p) => haversineMeters(cLat, cLon, p.lat, p.lon) <= STAY_RADIUS_M);
		if (inCluster.length < 2) continue;

		const duration = inCluster[inCluster.length - 1].ts - inCluster[0].ts;
		if (duration < STAY_MIN_DURATION_SEC) continue;

		stays.push({
			startTs: inCluster[0].ts,
			endTs: inCluster[inCluster.length - 1].ts,
			mode: "stationary",
			confidence: 0.7,
			avgSpeed: 0,
			maxSpeed: 0,
			linearity: 0,
			pointCount: inCluster.length,
		});
	}
	return stays;
}

// --- Public API ---

const WINDOW_SEC = 300; // 5 minute windows
const MIN_SEGMENT_SEC = 120; // segments shorter than 2 min get merged

/**
 * Classify a Kalman-filtered GPS track into transport mode segments.
 *
 * Optionally accepts a separate (looser-accuracy) point set to use for
 * stay detection — indoor GPS is often filtered out of the movement
 * pipeline but is still useful evidence that you were at one place.
 */
export function classifySegments(points: FilteredPoint[], stayPoints?: StayPoint[]): TrackSegment[] {
	const windows = extractFeatures(points, WINDOW_SEC);

	let classified: TrackSegment[] = [];
	if (windows.length > 0) {
		const scores = windows.map(scoreWindow);
		const raw = mergeWindows(windows, scores);
		classified = smoothSegments(raw, MIN_SEGMENT_SEC);
	}

	const stays = findStays(stayPoints ?? points, classified);
	return [...classified, ...stays].sort((a, b) => a.startTs - b.startTs);
}
