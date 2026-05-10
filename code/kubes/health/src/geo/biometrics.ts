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

/** One row from `steps_intraday`. The DB stores only non-zero minutes — a
 *  missing minute is implicit zero. */
export interface StepPoint {
	ts: number; // unix seconds, top-of-minute
	steps: number;
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
	/** Total steps recorded inside the segment (Fitbit 1-min intraday).
	 *  Null when no step rows touched the window — distinguish from zero
	 *  steps actively recorded. */
	stepsTotal: number | null;
}

const EMPTY_BIOMETRICS: BiometricEnrichment = {
	hrMean: null,
	hrMin: null,
	hrMax: null,
	hrStd: null,
	sampleCount: 0,
	overlapsSleep: false,
	sleepFraction: 0,
	stepsTotal: null,
};

export function enrichSegmentWithBiometrics(
	segment: TrackSegment,
	hrPoints: HrPoint[],
	sleepStages: SleepStageRecord[],
	stepPoints: StepPoint[] = [],
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

	// Step total. Each row in steps_intraday represents one minute starting at
	// `ts`; we sum all minutes whose top-of-minute falls inside the segment.
	// Only attribute steps if the array contains *any* row covering the
	// segment's day — otherwise leave as null (no Fitbit data, distinct from
	// "Fitbit recorded zero steps").
	if (stepPoints.length > 0) {
		let total = 0;
		let anyOverlap = false;
		for (const sp of stepPoints) {
			if (sp.ts >= segment.startTs && sp.ts <= segment.endTs) {
				total += sp.steps;
				anyOverlap = true;
			}
		}
		// Even if no non-zero minutes fell in the window, presence of step rows
		// for the day implies the Fitbit was on; treat that as zero steps.
		if (anyOverlap || stepPoints.some((sp) => Math.abs(sp.ts - segment.startTs) < 86400)) {
			result.stepsTotal = total;
		}
	}

	return result;
}

/** Steps per minute over a segment'\''s window. Zero if the segment is shorter
 *  than 30 seconds (denominator too small to be meaningful). Steps outside
 *  the window are ignored. */
export function cadenceForSegment(segment: TrackSegment, stepPoints: StepPoint[]): number {
	const durationSec = segment.endTs - segment.startTs;
	if (durationSec < 30) return 0;
	let total = 0;
	for (const sp of stepPoints) {
		if (sp.ts >= segment.startTs && sp.ts <= segment.endTs) total += sp.steps;
	}
	return (total / durationSec) * 60;
}

// --- Cadence-based mode correction ---

/** A walking-classified segment with cadence below this is almost certainly
 *  not walking — typical walking is 80–120 steps/min, jogging 130+, slow
 *  strolling ~40, busy urban walking with stops ~25–40, and even Fitbit
 *  partial-data minutes for real walking can dip into single digits. Set
 *  the threshold to 5 to only correct genuinely-zero cases (passenger in
 *  vehicle, escalator, shuttle); anything above 5 is more likely real
 *  walking with sparse Fitbit data than vehicle transit.
 *
 *  Tradeoff: false positives (real walks → driving) corrupt the timeline
 *  more visibly than false negatives (passenger trip kept as walking).
 *  Erring conservative is intentional. */
const WALKING_MIN_CADENCE = 5;

/** Don'\''t correct very short segments — a 1-min "walking" segment with
 *  zero steps could be a brief pause. Need enough samples to be confident. */
const CADENCE_CORRECTION_MIN_DURATION_S = 3 * 60;

/** Above this speed, the segment classifier already wouldn'\''t pick walking
 *  — cadence correction shouldn'\''t fight that boundary. */
const WALKING_MAX_SPEED_KMH = 15;

/** Require at least one step row at or after the segment'\''s end within this
 *  window — proof that Fitbit data has been synced through the segment'\''s
 *  time period. Without this, "no steps recorded" might just mean "we
 *  haven'\''t pulled this minute from Fitbit yet" and we'\''d wrongly correct
 *  a real walk into driving. */
const CADENCE_CORRECTION_FRESHNESS_S = 30 * 60;

/** Use cadence to correct mode classifications that GPS alone got wrong.
 *  Today: only the walking-with-no-steps case → relabel as driving (typical
 *  pattern is "passenger stuck in slow traffic"). Other corrections may
 *  follow as we learn what'\''s useful.
 *
 *  Pure: needs a `TrackSegment`-shaped input plus the day'\''s step rows.
 *  Returns a segment with `refinedMode` / `refinedReason` updated when a
 *  correction applies; otherwise returns the input unchanged.
 *
 *  Conservative on missing data: if `stepPoints` is empty (no Fitbit data
 *  for the day at all), no correction is applied — we don'\''t know the
 *  cadence and a false-positive correction would be worse than leaving
 *  the GPS classification alone.
 */
export function correctModeFromCadence<T extends TrackSegment & { refinedMode?: string; refinedReason?: string }>(
	segment: T,
	stepPoints: StepPoint[],
): T {
	if (stepPoints.length === 0) return segment;
	const duration = segment.endTs - segment.startTs;
	if (duration < CADENCE_CORRECTION_MIN_DURATION_S) return segment;

	const currentMode = segment.refinedMode ?? segment.mode;
	if (currentMode !== "walking") return segment;
	if (segment.avgSpeed > WALKING_MAX_SPEED_KMH) return segment;

	// Freshness guard: only correct when there'\''s a step row at-or-after the
	// segment'\''s end, within the freshness window. That proves Fitbit data
	// has been pulled through the segment'\''s time period; otherwise zero
	// cadence might just mean the most recent sync hasn'\''t covered this
	// minute yet, and a real walk would be wrongly relabelled as driving.
	const hasFreshData = stepPoints.some(
		(sp) => sp.ts >= segment.endTs && sp.ts <= segment.endTs + CADENCE_CORRECTION_FRESHNESS_S,
	);
	if (!hasFreshData) return segment;

	const cadence = cadenceForSegment(segment, stepPoints);
	if (cadence >= WALKING_MIN_CADENCE) return segment;

	const reason = `low cadence (${cadence.toFixed(0)}/min)`;
	return {
		...segment,
		refinedMode: "driving",
		refinedReason: segment.refinedReason ? `${segment.refinedReason}; ${reason}` : reason,
	};
}
