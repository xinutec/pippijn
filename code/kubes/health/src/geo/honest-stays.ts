/**
 * Honest-gaps Phase 2: re-evaluate emitted stationary stays for hidden
 * mid-stay departures, using multi-signal weighted evidence.
 *
 * `findStays` in `segments.ts` emits one stationary segment per spatial
 * cluster, but cannot tell from GPS alone whether a long gap between
 * two in-cluster fixes is "user stayed silently, phone went idle" or
 * "user briefly left and came back". Both patterns leave the same
 * trace: two clusters of in-place fixes bracketing a no-fix window.
 *
 * This pass combines four signals to estimate the likelihood of
 * mid-stay departure, then splits only when the evidence is strong
 * enough to warrant breaking the stay (and emits an `unknown` segment
 * in the gap so downstream rendering shows the departure honestly):
 *
 *   - **Biometric step count during the gap.** This is the *only*
 *     direct evidence of movement we have. Steps mid-gap = the user
 *     moved. Zero steps = the user sat. Drives the score on its own.
 *   - **Gap-anomaly ratio.** When the cluster has a dense pre-gap
 *     fix history, an anomalously long gap *amplifies* the step
 *     signal — but contributes nothing on its own. A long gap with
 *     no steps is the "phone died" pattern, not the "user left"
 *     pattern.
 *   - **HR during the gap.** Sustained elevation above resting
 *     baseline is supporting evidence of activity; restful HR is
 *     mild counter-evidence.
 *   - **Post-gap fix proximity.** A fix that lands back inside ~20 m
 *     of the cluster centroid is mild counter-evidence (the user
 *     returned to the exact same spot, more consistent with
 *     "didn't really leave").
 *
 * Calibration is deliberately conservative — the bias is toward NOT
 * splitting. A slight over-merge ("user was at hotel for 1h25m" when
 * they actually went out briefly) is far less misleading than a
 * fabricated split that breaks a quiet at-home evening into multiple
 * sub-stays. Cases where step data is too ambiguous to distinguish
 * "brief errand" from "sat silently" stay merged — the honest
 * "don't know" answer is to leave the data's ambiguity intact.
 */

import type { HrPoint, StepPoint } from "./biometrics.js";
import type { FilteredPoint } from "./kalman.js";
import type { TrackSegment } from "./segments.js";

export interface SplitContext {
	hr: HrPoint[];
	steps: StepPoint[];
}

/** Minimum in-stay gap (seconds) to even consider as a potential
 *  departure point. Shorter gaps are normal GPS jitter and not worth
 *  evaluating. */
const MIN_GAP_TO_EVALUATE_S = 15 * 60;

/** Log-evidence threshold for splitting. Conservative — splits only on
 *  overwhelming evidence (clear in-gap step activity, or many steps
 *  combined with a very anomalous gap). The bias is toward NOT
 *  splitting: a slight over-merge of a stay is far less misleading
 *  than a fabricated split that breaks a quiet at-home evening into
 *  multiple sub-stays. */
const SPLIT_THRESHOLD_NATS = 2.5;

/** Minimum number of pre-gap in-cluster fixes before the
 *  gap-anomaly signal is meaningful. Below this the cluster has no
 *  established fix density and the ratio can't distinguish "user
 *  left" from "GPS finally fired again". */
const GAP_ANOMALY_MIN_PRE_FIXES = 5;

/** Compute haversine distance in metres. Shared with segments.ts but
 *  duplicated here to keep this module standalone. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface GapEvidence {
	gapDurationS: number;
	medianPriorGapS: number;
	preGapFixCount: number;
	stepsInGap: number;
	hrMeanInGap: number | null;
	hrSamplesInGap: number;
	postGapDistFromCentroidM: number;
}

/** Compute weighted log-evidence that the user *left* during this gap.
 *  Positive → evidence of departure. Negative → evidence of continued
 *  stay. Sum across signals; > SPLIT_THRESHOLD_NATS triggers a split.
 *
 *  Calibration philosophy: step density is the only DIRECT evidence
 *  of movement we have. HR, gap-anomaly, and proximity are supporting
 *  signals — they can amplify or counter the step signal but cannot
 *  drive a split on their own. A long gap with zero steps and resting
 *  HR is strong evidence of sitting silently, not leaving. The bias
 *  is toward NOT splitting: a slight over-merge is less misleading
 *  than a fabricated split. */
export function scoreSplitEvidence(ev: GapEvidence): number {
	const gapMin = ev.gapDurationS / 60;
	if (gapMin <= 0) return 0;
	const stepsPerMin = ev.stepsInGap / gapMin;

	// Primary signal — biometric step density. This is the only direct
	// evidence of movement. Resting human (sitting, sleeping, watching
	// TV): 0-1 steps/min from incidental wrist motion. At-place
	// fidgeting / brief moves to fridge/bathroom: 1-3 steps/min.
	// Light walking: 5-15 steps/min. Brisk walking: 30+ steps/min.
	let score: number;
	if (stepsPerMin > 20)
		score = 3.5; // unambiguous sustained walking
	else if (stepsPerMin > 8)
		score = 2.0; // clear movement
	else if (stepsPerMin > 3)
		score = 0.5; // some movement but ambiguous
	else if (stepsPerMin > 1)
		score = -0.5; // at-place fidgeting
	else score = -2.0; // strong evidence of sitting

	// Supporting signal — gap-anomaly ratio. Amplifies the step signal
	// when both are positive, otherwise neutral. A very anomalous gap
	// (ratio > 50) with no steps is the "phone died" pattern, not the
	// "user left" pattern — we don't add positive evidence on the
	// gap-anomaly alone.
	if (ev.preGapFixCount >= GAP_ANOMALY_MIN_PRE_FIXES && ev.medianPriorGapS > 0 && score > 0) {
		const ratio = ev.gapDurationS / ev.medianPriorGapS;
		if (ratio > 50)
			score += 1.0; // very anomalous + movement → confident
		else if (ratio > 10) score += 0.5; // mildly anomalous + movement → mild boost
	}

	// Supporting signal — HR during the gap. Sustained elevation above
	// resting baseline is supporting evidence of activity; restful HR
	// is mild counter-evidence. We don't have per-user baseline here;
	// thresholds reflect typical population baselines (60-80 resting,
	// 95+ light activity, 110+ brisk).
	if (ev.hrSamplesInGap >= 3 && ev.hrMeanInGap !== null) {
		if (ev.hrMeanInGap > 110) score += 0.8;
		else if (ev.hrMeanInGap > 95) score += 0.3;
		else if (ev.hrMeanInGap < 75) score -= 0.5;
	}

	// Counter-evidence — post-gap fix landed back inside ~20 m of
	// cluster centroid. Mild signal that the user didn't really leave
	// (or left and returned to the exact same spot). Doesn't outweigh
	// strong step-density signals.
	if (ev.postGapDistFromCentroidM < 20) score -= 0.5;

	return score;
}

/**
 * Re-evaluate findStays output. For each stationary segment, walk its
 * in-segment fix sequence; at each gap ≥ MIN_GAP_TO_EVALUATE_S compute
 * weighted split evidence and split where joint evidence exceeds
 * SPLIT_THRESHOLD_NATS.
 *
 * When a stay is split, an `unknown` segment is emitted between the
 * resulting sub-stays — so downstream rendering shows the honest "we
 * don't know what the user was doing" gap rather than implicitly
 * stitching sub-stays back together via `mergeAdjacent`. The sub-stays
 * inherit the parent's metadata (place, city, displayTz) so the place
 * label is preserved across the split.
 *
 * Non-stationary segments and pointCount=0 synthetic segments are
 * passed through untouched. The output preserves segment order.
 */
export function reEvaluateStaysWithEvidence(
	segments: readonly TrackSegment[],
	points: readonly FilteredPoint[],
	ctx: SplitContext,
): TrackSegment[] {
	const out: TrackSegment[] = [];
	for (const seg of segments) {
		if (seg.mode !== "stationary" || seg.pointCount < 2) {
			out.push(seg);
			continue;
		}
		const segFixes = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs).sort((a, b) => a.ts - b.ts);
		if (segFixes.length < 2) {
			out.push(seg);
			continue;
		}
		const subRuns = splitByEvidence(segFixes, ctx);
		if (subRuns.length <= 1) {
			out.push(seg);
			continue;
		}
		for (let i = 0; i < subRuns.length; i++) {
			const run = subRuns[i];
			out.push({
				...seg,
				startTs: run[0].ts,
				endTs: run[run.length - 1].ts,
				pointCount: run.length,
			});
			if (i < subRuns.length - 1) {
				const gapStart = run[run.length - 1].ts;
				const gapEnd = subRuns[i + 1][0].ts;
				const min = Math.round((gapEnd - gapStart) / 60);
				out.push({
					startTs: gapStart,
					endTs: gapEnd,
					mode: "unknown",
					confidence: 0.1,
					confidenceMargin: 1,
					avgSpeed: 0,
					maxSpeed: 0,
					linearity: 0,
					pointCount: 0,
					refinedReason: `no GPS coverage for ${min} min (mid-stay departure inferred from biometric / fix-density evidence)`,
				});
			}
		}
	}
	return out;
}

/** Walk fixes in time order, accumulating into sub-runs; close a run
 *  when the gap to the next fix scores above SPLIT_THRESHOLD_NATS. */
function splitByEvidence(fixes: FilteredPoint[], ctx: SplitContext): FilteredPoint[][] {
	const runs: FilteredPoint[][] = [[fixes[0]]];
	const priorGapsInRun: number[] = [];
	let runCentroidLat = fixes[0].lat;
	let runCentroidLon = fixes[0].lon;

	for (let i = 1; i < fixes.length; i++) {
		const prev = fixes[i - 1];
		const cur = fixes[i];
		const gapS = cur.ts - prev.ts;

		// Short gaps: just join the current run, update centroid + gap stats.
		if (gapS < MIN_GAP_TO_EVALUATE_S) {
			const run = runs[runs.length - 1];
			run.push(cur);
			priorGapsInRun.push(gapS);
			runCentroidLat += (cur.lat - runCentroidLat) / run.length;
			runCentroidLon += (cur.lon - runCentroidLon) / run.length;
			continue;
		}

		// Long gap: evaluate split evidence.
		const stepsInGap = ctx.steps.filter((s) => s.ts > prev.ts && s.ts < cur.ts).reduce((sum, s) => sum + s.steps, 0);
		const hrInGap = ctx.hr.filter((h) => h.ts > prev.ts && h.ts < cur.ts);
		const hrMean = hrInGap.length > 0 ? hrInGap.reduce((s, h) => s + h.bpm, 0) / hrInGap.length : null;
		const postGapDist = haversineMeters(runCentroidLat, runCentroidLon, cur.lat, cur.lon);
		const score = scoreSplitEvidence({
			gapDurationS: gapS,
			medianPriorGapS: priorGapsInRun.length > 0 ? median(priorGapsInRun) : 0,
			preGapFixCount: runs[runs.length - 1].length,
			stepsInGap,
			hrMeanInGap: hrMean,
			hrSamplesInGap: hrInGap.length,
			postGapDistFromCentroidM: postGapDist,
		});

		if (score > SPLIT_THRESHOLD_NATS) {
			// Close current run, start a fresh one at this fix.
			runs.push([cur]);
			priorGapsInRun.length = 0;
			runCentroidLat = cur.lat;
			runCentroidLon = cur.lon;
		} else {
			// Stay merged — long gap not strong enough evidence of departure.
			const run = runs[runs.length - 1];
			run.push(cur);
			priorGapsInRun.push(gapS);
			runCentroidLat += (cur.lat - runCentroidLat) / run.length;
			runCentroidLon += (cur.lon - runCentroidLon) / run.length;
		}
	}

	return runs;
}
