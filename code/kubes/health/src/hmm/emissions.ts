/**
 * Per-state emission log-likelihood for the MVP HMM.
 *
 * `p(O_t | s) = p_gps_present(present | s)
 *              · p_speed(speed | s)
 *              · p_hr(hr | s)
 *              · p_cadence(cadence | s)`
 *
 * Conditional independence across modalities is an assumption — the
 * HMM design (`docs/archive/2025-model-hmm.md`) calls this out as
 * adequate in practice. State already encodes the latent cause, so
 * the modalities are correlated only via state. Cross-modality
 * correlation (e.g. GPS-absent ↔ HR-still-present in a tunnel) is
 * captured by the state-specific Bernoulli `p_gps_present(s)`.
 *
 * Per-mode prior calibration (hand-tuned for MVP; mixture emissions
 * and EM-fit per-state distributions are post-MVP per the proposal
 * "what MVP defers" list):
 *
 *   - **stationary**: speed ~ 0 (σ=2), HR ~ 70 (σ=15), cadence ~ 0
 *     (zero-inflated). GPS-present probability 0.95 (rare missing
 *     fixes when sitting outdoors with the phone).
 *   - **walking**: speed ~ 5 (σ=2), HR ~ 100 (σ=20), cadence ~ 100
 *     (σ=25). GPS-present 0.95.
 *   - **cycling**: speed ~ 18 (σ=6), HR ~ 130 (σ=20), cadence ~ 0
 *     (zero-inflated). GPS-present 0.95.
 *   - **driving**: speed ~ 40 (σ=20), HR ~ 75 (σ=15), cadence = 0.
 *     GPS-present 0.9.
 *   - **train**: speed ~ 50 (σ=30), HR ~ 75 (σ=15), cadence = 0.
 *     GPS-present 0.3 (often in tunnels; the LOW present-prob is
 *     the disambiguating signal vs driving for the Met-Line-under-
 *     Euston-Underpass case).
 *   - **plane**: speed ~ 600 (σ=200), HR ~ 70 (σ=15), cadence = 0.
 *     GPS-present 0.7.
 *   - **unknown**: uniform-ish very-low priors — explicitly weaker
 *     than any positive-evidence state. Used as a backstop so the
 *     decoder never falls through to NaN; in practice rarely the
 *     MAP because positive-evidence states always score higher.
 *
 * Missing biometric inputs (null) skip that factor — they don't
 * penalise. This matches the "Fitbit on charger" case: HR missing
 * shouldn't make walking less likely.
 *
 * Pure function. Place / line geometry terms (p(gps_lat,lon | place)
 * + p(gps | line)) are post-MVP — wired at integration time when
 * the per-place coordinates and per-line geometry are available.
 */

import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

export type EmissionLogProbFn = (state: State, obs: Observation) => number;

export interface BuildEmissionFnOpts {
	// Reserved for post-MVP per-place / per-line lookups.
	// Empty for now; placeholder so callers stabilise the API.
	_unused?: never;
}

interface ModePrior {
	gpsPresentProb: number; // P(gps fix present | mode)
	speedMean: number;
	speedStd: number;
	hrMean: number;
	hrStd: number;
	// Cadence: zero-inflated. positiveMean/Std apply when cadence > 0.
	// expectedZeroProb is the probability of an explicit-zero
	// observation under this mode (high for moving-but-not-walking;
	// low for walking).
	expectedZeroProb: number;
	cadencePositiveMean: number;
	cadencePositiveStd: number;
}

const MODE_PRIORS: Record<State["mode"], ModePrior> = {
	stationary: {
		gpsPresentProb: 0.95,
		speedMean: 0,
		speedStd: 2,
		hrMean: 70,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 10,
		cadencePositiveStd: 20,
	},
	walking: {
		gpsPresentProb: 0.95,
		speedMean: 5,
		speedStd: 2,
		hrMean: 100,
		hrStd: 20,
		expectedZeroProb: 0.05,
		cadencePositiveMean: 100,
		cadencePositiveStd: 25,
	},
	cycling: {
		gpsPresentProb: 0.95,
		speedMean: 18,
		speedStd: 6,
		hrMean: 130,
		hrStd: 20,
		expectedZeroProb: 0.95,
		cadencePositiveMean: 30,
		cadencePositiveStd: 30,
	},
	driving: {
		gpsPresentProb: 0.9,
		speedMean: 40,
		speedStd: 20,
		hrMean: 75,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 5,
		cadencePositiveStd: 10,
	},
	train: {
		gpsPresentProb: 0.3,
		speedMean: 50,
		speedStd: 30,
		hrMean: 75,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 5,
		cadencePositiveStd: 10,
	},
	plane: {
		gpsPresentProb: 0.7,
		speedMean: 600,
		speedStd: 200,
		hrMean: 70,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 5,
		cadencePositiveStd: 10,
	},
	unknown: {
		// Weak uniform-ish backstop. Drawn to always lose to a
		// positive-evidence state in head-to-head scoring.
		gpsPresentProb: 0.5,
		speedMean: 20,
		speedStd: 200, // very wide → always low density per data point
		hrMean: 80,
		hrStd: 100,
		expectedZeroProb: 0.5,
		cadencePositiveMean: 50,
		cadencePositiveStd: 100,
	},
};

const LOG_2PI = Math.log(2 * Math.PI);

/** log of Gaussian pdf at value x with mean μ and std σ. */
function logNormalPdf(x: number, mu: number, sigma: number): number {
	if (sigma <= 0) return Number.NEGATIVE_INFINITY;
	const z = (x - mu) / sigma;
	return -0.5 * z * z - Math.log(sigma) - 0.5 * LOG_2PI;
}

function logBernoulli(present: boolean, pPresent: number): number {
	if (pPresent <= 0) return present ? Number.NEGATIVE_INFINITY : 0;
	if (pPresent >= 1) return present ? 0 : Number.NEGATIVE_INFINITY;
	return Math.log(present ? pPresent : 1 - pPresent);
}

/** Zero-inflated cadence log-pdf. */
function logCadencePdf(cadence: number, prior: ModePrior): number {
	if (cadence === 0) return Math.log(prior.expectedZeroProb);
	// Positive cadence: mix the (1 - expectedZeroProb) mass over the
	// positive-cadence Gaussian.
	const positiveMix = Math.log(1 - prior.expectedZeroProb);
	return positiveMix + logNormalPdf(cadence, prior.cadencePositiveMean, prior.cadencePositiveStd);
}

export function buildEmissionFn(_opts: BuildEmissionFnOpts = {}): EmissionLogProbFn {
	return (state: State, obs: Observation): number => {
		const prior = MODE_PRIORS[state.mode];
		let logProb = 0;

		// GPS-present Bernoulli — fires every minute.
		logProb += logBernoulli(obs.gps !== null, prior.gpsPresentProb);

		// Speed: only if GPS present (no speed without a fix).
		if (obs.gps !== null) {
			logProb += logNormalPdf(obs.gps.speedKmh, prior.speedMean, prior.speedStd);
		}

		// HR: only if HR sample present (missing HR doesn't penalise
		// any mode — the Fitbit-on-charger case).
		if (obs.hr !== null) {
			logProb += logNormalPdf(obs.hr, prior.hrMean, prior.hrStd);
		}

		// Cadence: only if step row present (null means "no row
		// written" — informational, but not a penalty).
		if (obs.cadence !== null) {
			logProb += logCadencePdf(obs.cadence, prior);
		}

		return logProb;
	};
}
