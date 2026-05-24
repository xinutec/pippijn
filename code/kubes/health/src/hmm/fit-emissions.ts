/**
 * Supervised MLE fit of per-mode emission distributions from
 * heuristic-labeled minute samples.
 *
 * Input: a flat array of `(mode, observation)` pairs harvested from
 *   labeled days — one per minute where the heuristic emitted a
 *   confident state and the observation has at least one modality.
 *
 * Output: per-mode Gaussian / zero-inflated-Gaussian fits, ready to
 *   be persisted into `learned_hmm_models` and consumed by the
 *   inference-time emission function.
 *
 * Modes that don't reach `MIN_SAMPLES_PER_MODE` labeled samples are
 * marked `"fallback"` so the inference caller can use the hand-
 * tuned `MODE_PRIORS` for those modes — better than overfitting
 * a Gaussian to 20 noisy samples.
 *
 * Pure function. No DB, no IO, no globals.
 */

import type { TransportMode } from "../geo/segments.js";

/** A single labeled minute used as a training sample. */
export interface LabeledSample {
	mode: TransportMode;
	/** Heart rate (bpm) at the minute, or `null` if no HR reading. */
	hr: number | null;
	/** Cadence (steps/min). `0` is a meaningful value ("explicit zero
	 *  steps observed at this minute"). `null` is "no step row at
	 *  all" — different from explicit zero, and excluded from fit. */
	cadence: number | null;
	/** Speed in km/h at the minute, derived from the GPS fix. `null`
	 *  if `gpsPresent === false` (no fix → no speed). */
	speedKmh: number | null;
	/** Whether a GPS fix was present at this minute. */
	gpsPresent: boolean;
}

export interface GaussianFit {
	mean: number;
	std: number;
	sampleCount: number;
}

export interface ZeroInflatedCadenceFit {
	/** Fraction of observed cadence samples (non-null) that were 0. */
	expectedZeroProb: number;
	/** Gaussian fit on positive cadence samples. */
	positiveMean: number;
	positiveStd: number;
	positiveSampleCount: number;
	/** Count of all non-null cadence samples (zeros + positives). */
	totalSampleCount: number;
}

export interface LearnedModeParameters {
	/** P(GPS fix present | mode) — empirical. */
	gpsPresentProb: number;
	speed: GaussianFit;
	hr: GaussianFit;
	cadence: ZeroInflatedCadenceFit;
}

export interface TrainingSummary {
	totalSampleCount: number;
	samplesPerMode: Partial<Record<TransportMode, number>>;
}

export interface LearnedEmissionParameters {
	/** Per-mode learned parameters. `"fallback"` for modes that
	 *  didn't reach `MIN_SAMPLES_PER_MODE` — caller should use
	 *  hand-tuned `MODE_PRIORS` for those modes. */
	perMode: Partial<Record<TransportMode, LearnedModeParameters | "fallback">>;
	trainingSummary: TrainingSummary;
}

/** Below this sample count, a mode's fit is too noisy to trust;
 *  fall back to hand-tuned priors. */
export const MIN_SAMPLES_PER_MODE = 50;

/** Floor on HR stddev to prevent pathological overfitting. A
 *  user's HR is naturally noisy (±5 bpm minute-to-minute even at
 *  rest); a fit smaller than this is overconfident. */
export const HR_STD_FLOOR = 5;

/** Floor on speed stddev. Similar rationale. */
const SPEED_STD_FLOOR = 1;

/** Floor on cadence stddev. */
const CADENCE_STD_FLOOR = 5;

/** Floor on `expectedZeroProb` to prevent a hard-zero on inference-
 *  time cadence=0 observations. Fitbit only writes step rows when
 *  there ARE steps, so heuristic-labeled training minutes never see
 *  explicit zero cadence — but raw inference observations can have
 *  cadence=0 if a step row exists with 0 steps. Without a floor,
 *  `logCadencePdf(0, prior)` returns `log(0) = -Infinity`, hard-
 *  zeroing the entire state for that minute. */
const EXPECTED_ZERO_PROB_FLOOR = 0.01;

/** Fit a 1-D Gaussian via MLE with Bessel-corrected stddev. */
function fitGaussian(values: readonly number[], stdFloor: number): GaussianFit {
	const n = values.length;
	if (n === 0) return { mean: 0, std: stdFloor, sampleCount: 0 };
	let sum = 0;
	for (const v of values) sum += v;
	const mean = sum / n;
	if (n === 1) return { mean, std: stdFloor, sampleCount: 1 };
	let sumSq = 0;
	for (const v of values) sumSq += (v - mean) ** 2;
	const variance = sumSq / (n - 1);
	const std = Math.max(stdFloor, Math.sqrt(variance));
	return { mean, std, sampleCount: n };
}

export function fitPerModeEmissions(samples: readonly LabeledSample[]): LearnedEmissionParameters {
	// Bucket by mode.
	const byMode = new Map<TransportMode, LabeledSample[]>();
	for (const s of samples) {
		let bucket = byMode.get(s.mode);
		if (!bucket) {
			bucket = [];
			byMode.set(s.mode, bucket);
		}
		bucket.push(s);
	}

	const perMode: Partial<Record<TransportMode, LearnedModeParameters | "fallback">> = {};
	const samplesPerMode: Partial<Record<TransportMode, number>> = {};

	for (const [mode, modeSamples] of byMode.entries()) {
		samplesPerMode[mode] = modeSamples.length;
		if (modeSamples.length < MIN_SAMPLES_PER_MODE) {
			perMode[mode] = "fallback";
			continue;
		}

		const hrValues: number[] = [];
		const speedValues: number[] = [];
		const cadenceZeros: number[] = [];
		const cadencePositives: number[] = [];
		let gpsPresentCount = 0;

		for (const s of modeSamples) {
			if (s.hr !== null) hrValues.push(s.hr);
			if (s.gpsPresent && s.speedKmh !== null) speedValues.push(s.speedKmh);
			if (s.gpsPresent) gpsPresentCount += 1;
			if (s.cadence !== null) {
				if (s.cadence === 0) cadenceZeros.push(0);
				else cadencePositives.push(s.cadence);
			}
		}

		const cadenceTotal = cadenceZeros.length + cadencePositives.length;
		const rawZeroProb = cadenceTotal > 0 ? cadenceZeros.length / cadenceTotal : 0;
		const expectedZeroProb = Math.max(EXPECTED_ZERO_PROB_FLOOR, Math.min(1 - EXPECTED_ZERO_PROB_FLOOR, rawZeroProb));
		const positiveFit = fitGaussian(cadencePositives, CADENCE_STD_FLOOR);

		perMode[mode] = {
			gpsPresentProb: gpsPresentCount / modeSamples.length,
			speed: fitGaussian(speedValues, SPEED_STD_FLOOR),
			hr: fitGaussian(hrValues, HR_STD_FLOOR),
			cadence: {
				expectedZeroProb,
				positiveMean: positiveFit.mean,
				positiveStd: positiveFit.std,
				positiveSampleCount: positiveFit.sampleCount,
				totalSampleCount: cadenceTotal,
			},
		};
	}

	return {
		perMode,
		trainingSummary: {
			totalSampleCount: samples.length,
			samplesPerMode,
		},
	};
}
