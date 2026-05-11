/**
 * Per-user mode biometric signatures.
 *
 * Mines (HR, cadence, speed) joint distributions per transport mode from
 * historical data using heuristic labeling functions. The result is a
 * per-user, per-mode reference distribution that downstream classification
 * uses to disambiguate ambiguous segments — fixes the cycling-as-driving
 * bug at the right layer (HR-cadence-speed jointly distinguish them).
 *
 * Pure functions live here so the mining logic is testable without DB.
 */

import type { TransportMode } from "./segments.js";

/** A single per-minute observation, as fed into the labeling heuristic
 *  and into the per-mode aggregation. All fields are nullable because
 *  Fitbit data can be sparse (HR off, watch on charger, no GPS lock). */
export interface MinuteObservation {
	hr: number | null; // bpm
	cadence: number | null; // steps/min
	speed: number | null; // km/h
}

/** Summary statistics for one mode, computed from a user's historical
 *  labeled minutes. Null modality means "not enough samples to fit." */
export interface ModeStats {
	mode: string;
	hrMean: number | null;
	hrStd: number | null;
	hrSampleCount: number;
	cadenceMean: number | null;
	cadenceStd: number | null;
	cadenceSampleCount: number;
	speedMean: number | null;
	speedStd: number | null;
	speedSampleCount: number;
	sampleCount: number;
}

/**
 * Label a per-minute observation as a confident mode or null (ambiguous).
 * Designed for *clean* training data: many observations stay unlabeled —
 * that's fine, the goal is to characterise each mode's signature, not to
 * classify everything.
 *
 * Each rule's bands are chosen so the OTHER modes don't plausibly fit:
 * - Walking: 80-140 spm + 3-7 km/h. Below 80 spm could be tired or
 *   waiting; above 140 spm or above 7 km/h is jogging/running.
 * - Cycling: cadence 0 + 12-25 km/h + HR 100-170. Requires HR confirmation
 *   because cadence=0 + 18 km/h alone could be a slow drive.
 * - Driving: cadence 0 + speed > 30 + HR < 95 (or null). HR ceiling
 *   excludes cycling on a fast descent.
 * - Train: cadence 0 + speed > 80. Below 80 we may confuse with driving;
 *   above 80, no other mode plausibly hits this with cadence 0.
 * - Stationary: speed < 1 + cadence < 5.
 */
export function labelMinuteByHeuristic(obs: MinuteObservation): TransportMode | null {
	const { hr, cadence, speed } = obs;
	if (speed === null) return null;

	// Stationary: very low speed, very low cadence.
	if (speed < 1 && (cadence === null || cadence < 5)) {
		return "stationary";
	}

	// Walking: typical adult cadence + walking speed.
	if (cadence !== null && cadence >= 80 && cadence <= 140 && speed >= 3 && speed <= 7) {
		return "walking";
	}

	// Cycling: zero cadence + cycling speed + elevated HR (required).
	if (cadence !== null && cadence < 5 && speed >= 12 && speed <= 25 && hr !== null && hr >= 100 && hr <= 170) {
		return "cycling";
	}

	// Driving: zero cadence + driving speed + HR not in cycling range.
	if (cadence !== null && cadence < 5 && speed > 30 && speed <= 80 && (hr === null || hr < 95)) {
		return "driving";
	}

	// Train: zero cadence + train speed.
	if (cadence !== null && cadence < 5 && speed > 80 && (hr === null || hr < 95)) {
		return "train";
	}

	return null;
}

/**
 * Score the log-likelihood of an observation under a mode's Gaussian
 * emission per modality. Modalities with null observations OR null/zero
 * stats are skipped (contribute zero to log-likelihood — equivalent to
 * marginalising out). Returns `-Infinity` when every modality drops out.
 */
export function scoreModeLogLikelihood(obs: MinuteObservation, stats: ModeStats): number {
	let logLik = 0;
	let contributed = 0;
	const factor = (val: number | null, mean: number | null, std: number | null): void => {
		if (val === null || mean === null || std === null || std === 0) return;
		const z = (val - mean) / std;
		logLik += -0.5 * z * z;
		contributed++;
	};
	factor(obs.hr, stats.hrMean, stats.hrStd);
	factor(obs.cadence, stats.cadenceMean, stats.cadenceStd);
	factor(obs.speed, stats.speedMean, stats.speedStd);
	return contributed === 0 ? Number.NEGATIVE_INFINITY : logLik;
}

/** Minimum log-likelihood improvement (best alternative vs current) to
 *  trigger a re-label. Equivalent to a likelihood ratio of e^4 ≈ 55× —
 *  alternative explains the observation 55× better than current. */
const RELABEL_LL_THRESHOLD = 4;

/** Maximum original confidenceMargin at which we'll consider biometric
 *  re-classification. Above this the GPS-derived classification is
 *  treated as authoritative even if biometrics look slightly off. */
const RELABEL_MAX_MARGIN = 3;

/** Minimum number of non-null modality observations the segment must
 *  provide for biometric correction to have a real say. Speed alone
 *  isn't enough — we need at least one biometric signal. */
const RELABEL_MIN_BIOMETRIC_OBS = 1;

/**
 * Decide whether to relabel a segment's mode based on per-user
 * biometric signatures. Returns the chosen mode plus whether a change
 * was made.
 *
 * Triggers only when:
 *   - the segment's current mode is non-stationary (stays are
 *     detected by clustering, not by mode score)
 *   - the current classification is ambiguous (margin < RELABEL_MAX_MARGIN)
 *   - the segment carries at least one biometric observation (HR or
 *     cadence — speed alone isn't enough info)
 *   - an alternative mode has log-likelihood >= RELABEL_LL_THRESHOLD
 *     higher than the current mode
 */
export function correctModeBySignature(
	seg: {
		mode: string;
		confidenceMargin: number;
		obsHr: number | null;
		obsCadence: number | null;
		obsSpeed: number | null;
	},
	stats: ModeStats[],
): { mode: string; changed: boolean } {
	if (seg.mode === "stationary") return { mode: seg.mode, changed: false };
	if (seg.confidenceMargin >= RELABEL_MAX_MARGIN) return { mode: seg.mode, changed: false };
	if (stats.length === 0) return { mode: seg.mode, changed: false };

	const obs: MinuteObservation = { hr: seg.obsHr, cadence: seg.obsCadence, speed: seg.obsSpeed };
	const biometricObsCount = (obs.hr !== null ? 1 : 0) + (obs.cadence !== null ? 1 : 0);
	if (biometricObsCount < RELABEL_MIN_BIOMETRIC_OBS) return { mode: seg.mode, changed: false };

	let best = { mode: seg.mode, score: Number.NEGATIVE_INFINITY };
	let currentScore = Number.NEGATIVE_INFINITY;
	for (const s of stats) {
		const score = scoreModeLogLikelihood(obs, s);
		if (s.mode === seg.mode) currentScore = score;
		if (score > best.score) best = { mode: s.mode, score };
	}

	if (best.mode === seg.mode) return { mode: seg.mode, changed: false };
	if (best.score - currentScore < RELABEL_LL_THRESHOLD) return { mode: seg.mode, changed: false };
	return { mode: best.mode, changed: true };
}

/**
 * Aggregate labeled minute samples into per-mode summary stats. Modality
 * means/stds use only non-null values; mean is `null` when zero non-null
 * samples for that mode/modality. Population (not sample) std-dev.
 */
export function aggregateModeStats(samples: { mode: string; obs: MinuteObservation }[]): ModeStats[] {
	// Bucket samples by mode.
	const byMode = new Map<string, MinuteObservation[]>();
	for (const s of samples) {
		const arr = byMode.get(s.mode) ?? [];
		arr.push(s.obs);
		byMode.set(s.mode, arr);
	}

	const computeMeanStd = (values: (number | null)[]): { mean: number | null; std: number | null; count: number } => {
		const filtered = values.filter((v): v is number => v !== null);
		if (filtered.length === 0) return { mean: null, std: null, count: 0 };
		const mean = filtered.reduce((acc, v) => acc + v, 0) / filtered.length;
		const variance = filtered.reduce((acc, v) => acc + (v - mean) ** 2, 0) / filtered.length;
		return { mean, std: Math.sqrt(variance), count: filtered.length };
	};

	const stats: ModeStats[] = [];
	for (const [mode, obs] of byMode) {
		const hr = computeMeanStd(obs.map((o) => o.hr));
		const cadence = computeMeanStd(obs.map((o) => o.cadence));
		const speed = computeMeanStd(obs.map((o) => o.speed));
		stats.push({
			mode,
			hrMean: hr.mean,
			hrStd: hr.std,
			hrSampleCount: hr.count,
			cadenceMean: cadence.mean,
			cadenceStd: cadence.std,
			cadenceSampleCount: cadence.count,
			speedMean: speed.mean,
			speedStd: speed.std,
			speedSampleCount: speed.count,
			sampleCount: obs.length,
		});
	}
	return stats;
}
