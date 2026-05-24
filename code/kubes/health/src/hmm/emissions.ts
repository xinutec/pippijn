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
	/** focus_places coordinates keyed by place id. When provided,
	 *  `stationary @ placeId` states gain a place-distance emission
	 *  term: log Gaussian of distance from the observation's GPS fix
	 *  to the place's centroid, with σ = `PLACE_RADIUS_M`. When the
	 *  observation has no GPS fix, the term contributes nothing.
	 *
	 *  Without this, `stationary @ Home` and `stationary @ Work` and
	 *  `train @ Metropolitan Line` all score identically on a
	 *  GPS-null minute, which collapses the HMM's ability to attribute
	 *  the minute to the right state. */
	placeCoords?: ReadonlyMap<number, { lat: number; lon: number }>;

	/** **Deprecated for emissions** — time-of-day boost now lives in the
	 *  transition matrix as an entry-only event (see
	 *  `buildTransitionMatrix`'s `placeHourProfiles`). Per-minute
	 *  emission application accumulated to hundreds of nats over GPS-
	 *  null overnight stays, flipping the MAP path away from `Home` to
	 *  whichever Stay-place had the strongest night-time profile.
	 *  Kept on the options shape for API stability; ignored. */
	placeHourProfiles?: ReadonlyMap<number, readonly number[]>;

	/** **Deprecated for emissions** — visit-frequency now lives only in
	 *  the initial-state prior (`buildInitialStatePrior`). Per-minute
	 *  emission boosts accumulate over long stays and let the HMM
	 *  switch from `stationary @ Cleveland Clinic` to `stationary @
	 *  Home` mid-visit (~+4 nats/min × 60 min easily beats the
	 *  walking-transition path cost). Kept on the options shape for
	 *  API stability; ignored by `buildEmissionFn`. */
	placeVisitWeights?: ReadonlyMap<number, number>;
}

/** σ for the place-centroid Gaussian. Matches the
 *  `STAY_RADIUS_M = 150` used elsewhere in the pipeline — a fix
 *  more than ~3σ away from a place is essentially "not at that
 *  place." */
const PLACE_RADIUS_M = 150;

/** Fixed log-prior for the off-network stationary state when the
 *  observation has a GPS fix. Calibrated so:
 *    - A fix near (≲ 200 m of) a known place's centroid scores
 *      higher under `stationary @ knownPlace` than under
 *      `stationary @ none`.
 *    - A fix far (≳ 500 m) from all known places scores higher
 *      under `stationary @ none` than under any `stationary @
 *      knownPlace`.
 *  -4 nats hits both: at 500 m the place term is
 *  -0.5·(500/150)² ≈ -5.5, worse than -4; at 100 m it's -0.22,
 *  much better. */
const OFF_NETWORK_LOG_PRIOR = -4;

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

// GPS-presence as a per-mode Bernoulli was found in the Phase 1.5
// audit to be net-harmful: it can't distinguish "phone charging at
// home (GPS off)" from "deep in a tube tunnel (GPS off)" without
// per-(mode, place, time) conditioning that's out of MVP scope.
// Setting it to a uniform value across all modes makes GPS-absence
// inert — the per-minute decision falls to HR + speed + cadence +
// place-distance, which are actually discriminative.
const UNIFORM_GPS_PRESENT_PROB = 0.85;

const MODE_PRIORS: Record<State["mode"], ModePrior> = {
	stationary: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 0,
		speedStd: 2,
		hrMean: 70,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 10,
		cadencePositiveStd: 20,
	},
	walking: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 5,
		speedStd: 2,
		hrMean: 100,
		hrStd: 20,
		expectedZeroProb: 0.05,
		cadencePositiveMean: 100,
		cadencePositiveStd: 25,
	},
	cycling: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 18,
		speedStd: 6,
		hrMean: 130,
		hrStd: 20,
		expectedZeroProb: 0.95,
		cadencePositiveMean: 30,
		cadencePositiveStd: 30,
	},
	driving: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 40,
		speedStd: 20,
		// HR mean 70 (matching stationary + train) — driving is
		// sedentary; HR shouldn't tip a GPS-null minute toward
		// `driving` over `stationary`. Speed is the discriminator
		// when GPS is present.
		hrMean: 70,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 5,
		cadencePositiveStd: 10,
	},
	train: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
		speedMean: 50,
		speedStd: 30,
		// HR mean 70 (matching stationary) — train is sedentary; HR
		// shouldn't tip a GPS-null minute toward `train` over
		// `stationary`. Phase 1.7 audit found train.hrMean=75 made
		// slightly-elevated at-work HR (96, typical for typing /
		// meetings) score 0.5 nat/min higher under `train` than
		// `stationary`, accumulating over 90 min to dwarf the cost of
		// a fake train detour mid-workday. Speed remains the train-
		// vs-stationary discriminator (positive when GPS is present;
		// uninformative when GPS is null, as it should be).
		hrMean: 70,
		hrStd: 15,
		expectedZeroProb: 0.99,
		cadencePositiveMean: 5,
		cadencePositiveStd: 10,
	},
	plane: {
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
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
		gpsPresentProb: UNIFORM_GPS_PRESENT_PROB,
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

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function buildEmissionFn(opts: BuildEmissionFnOpts = {}): EmissionLogProbFn {
	const places = opts.placeCoords ?? null;
	// placeHourProfiles + placeVisitWeights deliberately not destructured.
	// Both moved out of emission per Phase 1.7 audit — see field docs.
	return (state: State, obs: Observation): number => {
		const prior = MODE_PRIORS[state.mode];
		let logProb = 0;

		// GPS-present Bernoulli — fires every minute.
		logProb += logBernoulli(obs.gps !== null, prior.gpsPresentProb);

		// Speed: only if GPS present (no speed without a fix).
		if (obs.gps !== null) {
			logProb += logNormalPdf(obs.gps.speedKmh, prior.speedMean, prior.speedStd);
		} else if (state.mode === "plane") {
			// GPS-null cannot reasonably indicate plane — being in the
			// air is exactly when GPS is most LIKELY to be present
			// (clear sky view; flight-mode toggles aside). Without
			// this penalty, the Phase 1.6 render audit showed the HMM
			// bridging through `plane` at every hour boundary between
			// alternative `stationary @ place` states because plane's
			// HR mean (70) matches resting and no speed evidence
			// constrains it. A strong negative on GPS-null forces
			// the HMM to prefer walking or a slower bridge.
			logProb += -8;
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

		// Time-of-day prior moved to transitions (Phase 1.7) — see
		// `placeHourProfiles` field doc.

		// Place-distance emission for stationary states. Without this
		// term, the HMM has no way to attribute a stationary GPS fix
		// to the right focus place — all `stationary @ placeId`
		// states emit identically on the non-geometric signals, and
		// the decoder falls back to whatever the transition prior
		// prefers (often the wrong place).
		//
		// Peak-normalised score: 0 at the centroid, -0.5·(d/σ)² away.
		// `stationary @ none` gets a fixed log-prior — see
		// `OFF_NETWORK_LOG_PRIOR`. Together: a fix close to a known
		// place scores higher there; a fix far from all known places
		// scores higher under `none`.
		//
		// Only applies when GPS is present (no place attribution
		// without observation).
		if (state.mode === "stationary" && places !== null && obs.gps !== null) {
			if (state.placeId !== null) {
				const placeCoord = places.get(state.placeId);
				if (placeCoord !== undefined) {
					const d = haversineMeters(obs.gps.lat, obs.gps.lon, placeCoord.lat, placeCoord.lon);
					const z = d / PLACE_RADIUS_M;
					logProb += -0.5 * z * z;
				}
			} else {
				logProb += OFF_NETWORK_LOG_PRIOR;
			}
		}

		return logProb;
	};
}
