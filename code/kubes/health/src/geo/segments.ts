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

function mergeWindows(windows: WindowFeatures[], scores: ModeScore[][]): TrackSegment[] {
	if (windows.length === 0) return [];

	const segments: TrackSegment[] = [];
	let currentMode = scores[0][0].mode;
	let _currentConfidence = scores[0][0].score;
	let segStart = 0;

	for (let i = 1; i <= windows.length; i++) {
		const newMode = i < windows.length ? scores[i][0].mode : null;

		if (newMode !== currentMode || i === windows.length) {
			// Close current segment
			const segWindows = windows.slice(segStart, i);
			const segScores = scores.slice(segStart, i);

			const allSpeeds = segWindows.map((w) => w.medianSpeed);
			const avgConfidence = segScores.reduce((sum, s) => sum + s[0].score, 0) / segScores.length;

			// Calculate linearity over the whole segment
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

			if (i < windows.length) {
				currentMode = newMode!;
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

// --- Public API ---

const WINDOW_SEC = 300; // 5 minute windows
const MIN_SEGMENT_SEC = 120; // segments shorter than 2 min get merged

/**
 * Classify a Kalman-filtered GPS track into transport mode segments.
 */
export function classifySegments(points: FilteredPoint[]): TrackSegment[] {
	const windows = extractFeatures(points, WINDOW_SEC);
	if (windows.length === 0) return [];

	const scores = windows.map(scoreWindow);
	const raw = mergeWindows(windows, scores);
	return smoothSegments(raw, MIN_SEGMENT_SEC);
}
