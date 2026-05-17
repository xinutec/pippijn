/**
 * Multi-signal naming for focus-place clusters (proposal
 * 2026-05-weighted-place-accumulation.md, Phase 4 §5).
 *
 * The old naming took the single nearest OSM venue to the cluster
 * centroid. Where venues pack within GPS error that is a coin-flip, and
 * it ignores everything the user's history says about what kind of
 * place they actually frequent.
 *
 * This scores every nearby venue by  score(v) = w_dist(v) · w_type(v):
 *  - w_dist: a soft Gaussian falloff from the cluster's weighted
 *    centroid — a venue a little further out is not crushed.
 *  - w_type: the *user's own* historical propensity for that kind of
 *    venue, mined from how their out-of-home dwell time splits across
 *    café / fast-food / clinical / … clusters. Behavioural data — not a
 *    hand-tuned or language-dependent assumption.
 *
 * OSM's `subtype` is trusted verbatim for the venue kind: it is a
 * language-neutral controlled vocabulary (`amenity=cafe` is `cafe`
 * worldwide). There is no name-string second-guessing — that cannot be
 * done language-neutrally, and a genuine OSM mis-tag is an upstream
 * data bug, not something to paper over here.
 *
 * Pure module — no DB, no I/O.
 */

import type { NearbyLandmark } from "./osm.js";

/** Coarse venue kind — the unit the behavioural prior is keyed on. */
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

/** The user's behavioural propensity for each venue kind — P(kind). */
export type KindPrior = ReadonlyMap<VenueKind, number>;

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
 *  *provisional* kind, used only as raw material for the prior. Null
 *  when no venue is nearby. */
export function nearestVenueKind(candidates: NearbyLandmark[]): VenueKind | null {
	const venues = candidates.filter((c) => VENUE_TYPES.has(c.type));
	if (venues.length === 0) return null;
	return venueKind(venues.reduce((a, b) => (b.distanceM < a.distanceM ? b : a)));
}

/**
 * Mine the per-user kind prior: each entry is one cluster's provisional
 * venue kind and its total dwell. P(kind) is dwell summed by kind and
 * normalised, with additive smoothing. With no history it is uniform.
 */
export function kindPrior(entries: { kind: VenueKind; dwellSec: number }[]): KindPrior {
	const dwell = new Map<VenueKind, number>(KINDS.map((k) => [k, 0]));
	for (const e of entries) dwell.set(e.kind, (dwell.get(e.kind) ?? 0) + e.dwellSec);
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

function distWeight(distanceM: number): number {
	return Math.exp(-(distanceM * distanceM) / (2 * DIST_SIGMA_M * DIST_SIGMA_M));
}

/**
 * Name a focus-place cluster by scoring every nearby OSM venue by its
 * distance to the cluster's converged centroid and the user's
 * behavioural propensity for that kind of venue.
 */
export function nameCluster(candidates: NearbyLandmark[], prior: KindPrior): PlaceNaming {
	const ranked: ScoredCandidate[] = candidates
		.filter((c) => VENUE_TYPES.has(c.type))
		.map((c) => ({
			name: c.name,
			subtype: c.subtype,
			distanceM: c.distanceM,
			score: distWeight(c.distanceM) * (prior.get(venueKind(c)) ?? 0),
		}))
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
