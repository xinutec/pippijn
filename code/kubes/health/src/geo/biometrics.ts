/**
 * Cross-modal segment enrichment with Fitbit biometrics.
 *
 * Pure module — no DB, no I/O. Caller loads HR intraday + sleep stages
 * (from MariaDB), converts timestamps to unix seconds via fitbitTsToUnix,
 * and passes to enrichSegmentWithBiometrics.
 *
 * Designed for graceful degradation: any subset of (HR, sleep) may be
 * missing because the user wasn't wearing the watch, the battery died,
 * or Fitbit hadn't synced yet. All fields go to null/0/false in those
 * cases — the timeline still works, just without the extra context.
 */

import type { TrackSegment } from "./segments.js";

export interface HrPoint {
	ts: number; // unix seconds
	bpm: number;
}

export interface SleepStageRecord {
	startTs: number;
	endTs: number;
	stage: string; // "asleep" | "awake" | "deep" | "light" | "rem" | "wake"
}

export interface BiometricEnrichment {
	/** Mean HR over the segment, or null if no HR samples in window. */
	hrMean: number | null;
	hrMin: number | null;
	hrMax: number | null;
	hrStd: number | null;
	/** Number of HR samples that fell inside the segment time window. */
	sampleCount: number;
	/** True if any sleep stage record overlapped the segment. */
	overlapsSleep: boolean;
	/** Fraction of segment duration covered by sleep records (0–1). */
	sleepFraction: number;
}

const EMPTY_BIOMETRICS: BiometricEnrichment = {
	hrMean: null,
	hrMin: null,
	hrMax: null,
	hrStd: null,
	sampleCount: 0,
	overlapsSleep: false,
	sleepFraction: 0,
};

export function enrichSegmentWithBiometrics(
	segment: TrackSegment,
	hrPoints: HrPoint[],
	sleepStages: SleepStageRecord[],
): BiometricEnrichment {
	const segDuration = segment.endTs - segment.startTs;
	const result: BiometricEnrichment = { ...EMPTY_BIOMETRICS };

	// HR stats
	const inWindow: number[] = [];
	for (const p of hrPoints) {
		if (p.ts >= segment.startTs && p.ts <= segment.endTs) inWindow.push(p.bpm);
	}
	if (inWindow.length > 0) {
		const sum = inWindow.reduce((a, b) => a + b, 0);
		const mean = sum / inWindow.length;
		const variance = inWindow.reduce((s, b) => s + (b - mean) ** 2, 0) / inWindow.length;
		result.hrMean = Math.round(mean * 10) / 10;
		result.hrMin = Math.min(...inWindow);
		result.hrMax = Math.max(...inWindow);
		result.hrStd = Math.round(Math.sqrt(variance) * 10) / 10;
		result.sampleCount = inWindow.length;
	}

	// Sleep overlap (sum of intersections, normalised by segment duration)
	if (segDuration > 0) {
		let overlapSec = 0;
		for (const stage of sleepStages) {
			const start = Math.max(segment.startTs, stage.startTs);
			const end = Math.min(segment.endTs, stage.endTs);
			if (end > start) overlapSec += end - start;
		}
		if (overlapSec > 0) {
			result.overlapsSleep = true;
			result.sleepFraction = Math.min(1, overlapSec / segDuration);
		}
	}

	return result;
}
