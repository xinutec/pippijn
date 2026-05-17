/**
 * Multi-signal naming for focus-place clusters (proposal
 * 2026-05-weighted-place-accumulation.md, Phase 4 §5).
 *
 * Scores every nearby OSM venue by
 *     score(v) = w_dist(v) · P(kind) · P(dwell | kind)
 *  - w_dist: soft Gaussian falloff from the cluster's weighted centroid.
 *  - P(kind): the user's global propensity for that kind of venue.
 *  - P(dwell | kind): how plausible this cluster's per-visit dwell is
 *    for that kind of venue — nobody spends 90 minutes in a bakery.
 *
 * Both P(kind) and P(dwell | kind) are mined each refresh from the
 * user's own clusters — behavioural data, nothing hand-tuned or
 * language-dependent. OSM's `subtype` is trusted verbatim for the venue
 * kind: a language-neutral controlled vocabulary, no name-string
 * second-guessing. A genuine OSM mis-tag is an upstream data bug.
 *
 * Pure module — no DB, no I/O.
 */

import type { NearbyLandmark } from "./osm.js";

/** Coarse venue kind — the unit the behavioural priors are keyed on. */
export type VenueKind = "linger" | "quick" | "clinical" | "evening" | "other";

const KINDS: readonly VenueKind[] = ["linger", "quick", "clinical", "evening", "other"];

/** OSM subtype → venue kind. OSM subtypes are a language-neutral
 *  controlled vocabulary; this is the only place kinds are assigned. */
const SUBTYPE_KIND: Record<string, VenueKind> = {
	cafe: "linger",
	coffee_shop: "linger",
	restaurant: "linger",
	coworking_space: "linger",
	library: "linger",
	fast_food: "quick",
	convenience: "quick",
	supermarket: "quick",
	bakery: "quick",
	pharmacy: "quick",
	dentist: "clinical",
	doctors: "clinical",
	clinic: "clinical",
	hospital: "clinical",
	pub: "evening",
	bar: "evening",
	nightclub: "evening",
};

/** OSM `type`s that name an actual venue; place/highway are not venues. */
const VENUE_TYPES = new Set<NearbyLandmark["type"]>(["amenity", "tourism", "leisure", "shop"]);
/** σ of the soft distance falloff — roughly a converged cluster's
 *  positional uncertainty. A venue 2σ (30 m) out still scores ~14%. */
const DIST_SIGMA_M = 15;
/** The top score must beat the runner-up by this factor to be asserted;
 *  otherwise the place is flagged ambiguous. */
const AMBIGUITY_MARGIN = 1.3;
/** Additive smoothing on the kind prior, so a kind the user has no
 *  history at is unlikely — not impossible. */
const PRIOR_SMOOTHING = 0.02;
/** Floor on the mined log-dwell spread — a numerical regulariser so a
 *  user whose clusters happen to share a dwell does not get a
 *  degenerate, zero-width dwell likelihood. */
const DWELL_SIGMA_FLOOR = 0.25;

/** One cluster's contribution to the mined behavioural models: its
 *  provisional venue kind, total dwell, and mean per-visit length. */
export interface ClusterStat {
	kind: VenueKind;
	totalDwellSec: number;
	visitLengthSec: number;
}

/** The user's behavioural propensity for each venue kind — P(kind). */
export type KindPrior = ReadonlyMap<VenueKind, number>;

/** Per-kind log-normal model of per-visit dwell length, mined from the
 *  user's clusters: how long a visit to each kind of venue tends to be. */
export interface DwellModel {
	/** Mean of ln(visit-length seconds) per kind. */
	meanLogByKind: ReadonlyMap<VenueKind, number>;
	/** Pooled within-kind standard deviation of ln(visit-length). */
	sigmaLog: number;
	/** Fallback mean for a kind the user has no history at. */
	globalMeanLog: number;
}

export interface ScoredCandidate {
	name: string;
	subtype: string;
	distanceM: number;
	score: number;
}

export interface PlaceNaming {
	/** Highest-scoring candidate's name, or null when there is no usable
	 *  venue candidate. Always the best guess — the caller decides
	 *  whether to commit it given `ambiguous`. */
	label: string | null;
	/** True when the top candidate did not clearly beat the runner-up. */
	ambiguous: boolean;
	/** Every venue candidate, scored, best first. */
	ranked: ScoredCandidate[];
}

function venueKind(c: NearbyLandmark): VenueKind {
	return SUBTYPE_KIND[c.subtype] ?? "other";
}

/** The venue kind of the nearest OSM venue to a cluster — its
 *  *provisional* kind, used only as raw material for the mined models.
 *  Null when no venue is nearby. */
export function nearestVenueKind(candidates: NearbyLandmark[]): VenueKind | null {
	const venues = candidates.filter((c) => VENUE_TYPES.has(c.type));
	if (venues.length === 0) return null;
	return venueKind(venues.reduce((a, b) => (b.distanceM < a.distanceM ? b : a)));
}

/**
 * Mine the per-user kind prior: P(kind) is each cluster's total dwell
 * summed by venue kind and normalised, with additive smoothing. With no
 * history it is uniform.
 */
export function kindPrior(stats: ClusterStat[]): KindPrior {
	const dwell = new Map<VenueKind, number>(KINDS.map((k) => [k, 0]));
	for (const s of stats) dwell.set(s.kind, (dwell.get(s.kind) ?? 0) + s.totalDwellSec);
	const total = [...dwell.values()].reduce((a, b) => a + b, 0);
	const prior = new Map<VenueKind, number>();
	if (total === 0) {
		for (const k of KINDS) prior.set(k, 1 / KINDS.length);
		return prior;
	}
	const norm = 1 + PRIOR_SMOOTHING * KINDS.length;
	for (const k of KINDS) {
		prior.set(k, ((dwell.get(k) ?? 0) / total + PRIOR_SMOOTHING) / norm);
	}
	return prior;
}

/**
 * Mine the per-kind dwell model: for each venue kind, the mean of
 * ln(per-visit length) across the user's clusters of that kind, plus a
 * single pooled within-kind spread. With no history the model is inert
 * (every dwell scores 1).
 */
export function mineDwellModel(stats: ClusterStat[]): DwellModel {
	if (stats.length === 0) {
		return { meanLogByKind: new Map(), sigmaLog: Number.POSITIVE_INFINITY, globalMeanLog: 0 };
	}
	const logsByKind = new Map<VenueKind, number[]>();
	const allLogs: number[] = [];
	for (const s of stats) {
		const x = Math.log(s.visitLengthSec);
		allLogs.push(x);
		let arr = logsByKind.get(s.kind);
		if (!arr) {
			arr = [];
			logsByKind.set(s.kind, arr);
		}
		arr.push(x);
	}
	const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
	const meanLogByKind = new Map<VenueKind, number>();
	for (const [k, xs] of logsByKind) meanLogByKind.set(k, mean(xs));
	const globalMeanLog = mean(allLogs);
	// Pooled within-kind variance — one spread, robust to kinds the user
	// has only a cluster or two of.
	let ss = 0;
	for (const s of stats) {
		const d = Math.log(s.visitLengthSec) - (meanLogByKind.get(s.kind) ?? globalMeanLog);
		ss += d * d;
	}
	return { meanLogByKind, sigmaLog: Math.max(Math.sqrt(ss / stats.length), DWELL_SIGMA_FLOOR), globalMeanLog };
}

function distWeight(distanceM: number): number {
	return Math.exp(-(distanceM * distanceM) / (2 * DIST_SIGMA_M * DIST_SIGMA_M));
}

/** P(this cluster's per-visit dwell | the venue is of this kind). */
function dwellWeight(visitLengthSec: number, kind: VenueKind, model: DwellModel): number {
	const mu = model.meanLogByKind.get(kind) ?? model.globalMeanLog;
	const d = Math.log(visitLengthSec) - mu;
	return Math.exp(-(d * d) / (2 * model.sigmaLog * model.sigmaLog));
}

/**
 * Name a focus-place cluster by scoring every nearby OSM venue by its
 * distance to the cluster's converged centroid, the user's propensity
 * for that kind of venue, and how well this cluster's per-visit dwell
 * fits that kind.
 */
export function nameCluster(
	candidates: NearbyLandmark[],
	prior: KindPrior,
	dwellModel: DwellModel,
	visitLengthSec: number,
): PlaceNaming {
	const ranked: ScoredCandidate[] = candidates
		.filter((c) => VENUE_TYPES.has(c.type))
		.map((c) => {
			const kind = venueKind(c);
			return {
				name: c.name,
				subtype: c.subtype,
				distanceM: c.distanceM,
				score: distWeight(c.distanceM) * (prior.get(kind) ?? 0) * dwellWeight(visitLengthSec, kind, dwellModel),
			};
		})
		.sort((a, b) => b.score - a.score);

	if (ranked.length === 0) return { label: null, ambiguous: false, ranked };
	const ambiguous = ranked.length > 1 && ranked[0].score / ranked[1].score < AMBIGUITY_MARGIN;
	return { label: ranked[0].name, ambiguous, ranked };
}

/**
 * The string to store as a cluster's `amenity_label`. A confident pick
 * is just its name; an ambiguous one is hedged as "winner / runner-up"
 * so the timeline shows the genuine uncertainty rather than committing
 * to a coin-flip between adjacent venues. Null when there is no
 * candidate at all.
 */
export function amenityLabelFor(naming: PlaceNaming): string | null {
	if (naming.label === null) return null;
	// `ambiguous` is only set when a runner-up exists (see nameCluster).
	if (naming.ambiguous) return `${naming.label} / ${naming.ranked[1].name}`;
	return naming.label;
}
