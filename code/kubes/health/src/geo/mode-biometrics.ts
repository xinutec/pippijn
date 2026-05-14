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

	// Train: zero cadence + 80–330 km/h. Upper bound covers fastest
	// scheduled high-speed rail (TGV 320, Shinkansen 285). Speeds above
	// the bound are likely plane climb-out / descent / cruise (see below).
	if (cadence !== null && cadence < 5 && speed > 80 && speed <= 330 && (hr === null || hr < 95)) {
		return "train";
	}

	// Plane: zero cadence + cruise speed. > 500 km/h is unambiguous —
	// no rail mode reaches it. The 330–500 km/h band is the plane
	// climb-out / descent / fast turboprop transition zone; we leave
	// it unlabeled rather than risk corrupting either signature.
	if (cadence !== null && cadence < 5 && speed > 500) {
		return "plane";
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

/** Modes where the user is sitting — biometrically indistinguishable
 *  (same low HR, same zero cadence). Biometric correction must not flip
 *  among these because speed alone is the discriminator, and speed is
 *  what GPS-feature classification + refineMode already used (with OSM
 *  road/rail context). Letting biometrics override their decision adds
 *  noise: motorway driving at 94 km/h gets flipped to train because the
 *  driving sample is dominated by 52 km/h city driving. */
const SIT_MODES = new Set(["driving", "train", "plane"]);

/** Number of stds below the per-mode HR mean at which the
 *  current mode's HR becomes biologically implausible. 2 σ on a
 *  Gaussian = ~2.3% of the distribution. Strict enough to avoid
 *  false vetoes during low-effort cycling, loose enough to catch
 *  the "labelled cycling but HR sits at resting" case where the
 *  observed HR is several σ below cycling's mean. */
const HR_VETO_SIGMA = 2.0;

/** Number of stds ABOVE the per-mode cadence mean at which the
 *  observed cadence becomes implausible for a "cadence ≈ 0" mode
 *  (cycling / driving / train / plane). */
const CADENCE_VETO_SIGMA = 2.0;

/** Floor on the cadence-veto threshold. Some users have a degenerate
 *  per-mode cadence distribution (mean=0, std=0 — every training
 *  sample was exactly zero), which would make mean + 2σ = 0 and veto
 *  *any* non-zero observed cadence. A floor of 30 spm cleanly separates
 *  pedalling-with-occasional-step-noise (typically 0-10 spm) from
 *  actual walking (~80-130 spm). */
const CADENCE_VETO_FLOOR_SPM = 30;

/** Modes whose biometric signature is "cadence ≈ 0" (pedalling /
 *  sitting / standing). A walking-range observed cadence inside one
 *  of these modes is biologically implausible. */
const LOW_CADENCE_MODES = new Set(["cycling", "driving", "train", "plane"]);

/** Hard veto: when the segment's observed HR is more than
 *  HR_VETO_SIGMA std-devs below the current mode's HR mean, the
 *  classification is biologically implausible regardless of how
 *  confidently the GPS+OSM classifier picked it. Demote to the
 *  highest-log-likelihood alternative mode.
 *
 *  Returns no-change when:
 *    - the current mode is stationary (HR-veto only applies to
 *      movement modes; stationary's HR distribution is the
 *      resting band itself);
 *    - no observed HR (no evidence);
 *    - no stats row for the current mode (cold-start user);
 *    - the current mode's stats row has no HR distribution
 *      (insufficient sample for that mode).
 *
 *  Designed as a separate function so the rule is testable on its
 *  own and slots cleanly into `correctModeBySignature` as a
 *  short-circuit before the log-likelihood comparison.
 */
export function vetoImplausibleHr(
	seg: { mode: string; obsHr: number | null; obsCadence: number | null; obsSpeed: number | null },
	stats: readonly ModeStats[],
): { mode: string; changed: boolean } {
	if (seg.mode === "stationary") return { mode: seg.mode, changed: false };
	if (seg.obsHr === null) return { mode: seg.mode, changed: false };
	const cur = stats.find((s) => s.mode === seg.mode);
	if (!cur || cur.hrMean === null || cur.hrStd === null || cur.hrStd <= 0) {
		return { mode: seg.mode, changed: false };
	}
	const minPlausible = cur.hrMean - HR_VETO_SIGMA * cur.hrStd;
	if (seg.obsHr >= minPlausible) return { mode: seg.mode, changed: false };

	// HR is implausible for the current mode. Pick the
	// highest-log-likelihood alternative as the demotion target.
	const obs: MinuteObservation = { hr: seg.obsHr, cadence: seg.obsCadence, speed: seg.obsSpeed };
	let best: { mode: string; score: number } | null = null;
	for (const s of stats) {
		if (s.mode === seg.mode) continue;
		const sc = scoreModeLogLikelihood(obs, s);
		if (best === null || sc > best.score) best = { mode: s.mode, score: sc };
	}
	if (best === null) return { mode: seg.mode, changed: false };
	return { mode: best.mode, changed: true };
}

/** Hard veto: when the segment is labelled one of the low-cadence
 *  modes (cycling / driving / train / plane) but the observed cadence
 *  is in walking range, the classification is biologically implausible.
 *  Demote to the highest-log-likelihood alternative.
 *
 *  Sibling to `vetoImplausibleHr`. Catches the case where HR sits in
 *  the cycling-borderline band (so HR-veto doesn't fire) but step
 *  cadence ~80 spm gives the walk away. April 29 motivator: Noordwal +
 *  Mauritskade phantom-cycling segments with cadence 80/86 spm.
 *
 *  Returns no-change when:
 *    - mode is not in LOW_CADENCE_MODES;
 *    - obsCadence is null;
 *    - no stats row for the current mode (cold-start user);
 *    - the current mode's stats row has no cadence distribution;
 *    - obsCadence is within max(mean + 2σ, FLOOR_SPM).
 */
export function vetoImplausibleCadence(
	seg: { mode: string; obsHr: number | null; obsCadence: number | null; obsSpeed: number | null },
	stats: readonly ModeStats[],
): { mode: string; changed: boolean } {
	if (!LOW_CADENCE_MODES.has(seg.mode)) return { mode: seg.mode, changed: false };
	if (seg.obsCadence === null) return { mode: seg.mode, changed: false };
	const cur = stats.find((s) => s.mode === seg.mode);
	if (!cur || cur.cadenceMean === null || cur.cadenceStd === null) {
		return { mode: seg.mode, changed: false };
	}
	const maxPlausible = Math.max(cur.cadenceMean + CADENCE_VETO_SIGMA * cur.cadenceStd, CADENCE_VETO_FLOOR_SPM);
	if (seg.obsCadence <= maxPlausible) return { mode: seg.mode, changed: false };

	const obs: MinuteObservation = { hr: seg.obsHr, cadence: seg.obsCadence, speed: seg.obsSpeed };
	let best: { mode: string; score: number } | null = null;
	for (const s of stats) {
		if (s.mode === seg.mode) continue;
		const sc = scoreModeLogLikelihood(obs, s);
		if (best === null || sc > best.score) best = { mode: s.mode, score: sc };
	}
	if (best === null) return { mode: seg.mode, changed: false };
	return { mode: best.mode, changed: true };
}

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

	// Biometric vetoes run FIRST, before the confidence-margin gate: a
	// classifier that's "confident" about cycling can still be
	// biologically impossible if HR sits in the resting band or
	// cadence is in walking range.
	const hrVeto = vetoImplausibleHr(seg, stats);
	if (hrVeto.changed) return hrVeto;
	const cadenceVeto = vetoImplausibleCadence(seg, stats);
	if (cadenceVeto.changed) return cadenceVeto;

	if (seg.confidenceMargin >= RELABEL_MAX_MARGIN) return { mode: seg.mode, changed: false };
	if (stats.length === 0) return { mode: seg.mode, changed: false };

	const obs: MinuteObservation = { hr: seg.obsHr, cadence: seg.obsCadence, speed: seg.obsSpeed };
	const biometricObsCount = (obs.hr !== null ? 1 : 0) + (obs.cadence !== null ? 1 : 0);
	if (biometricObsCount < RELABEL_MIN_BIOMETRIC_OBS) return { mode: seg.mode, changed: false };

	let best = { mode: seg.mode, score: Number.NEGATIVE_INFINITY };
	let currentScore = Number.NEGATIVE_INFINITY;
	let currentFound = false;
	for (const s of stats) {
		const score = scoreModeLogLikelihood(obs, s);
		if (s.mode === seg.mode) {
			currentScore = score;
			currentFound = true;
		}
		// Don't consider sit-modes as flip targets when the current mode
		// is also a sit-mode — they're biometrically equivalent.
		if (SIT_MODES.has(seg.mode) && SIT_MODES.has(s.mode) && s.mode !== seg.mode) continue;
		if (score > best.score) best = { mode: s.mode, score };
	}

	// No stats for current mode → we can't reason about whether the
	// alternative is genuinely better. Keep as classified.
	if (!currentFound) return { mode: seg.mode, changed: false };
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
