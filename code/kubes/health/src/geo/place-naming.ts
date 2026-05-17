/**
 * Multi-signal naming for focus-place clusters (proposal
 * 2026-05-weighted-place-accumulation.md, Phase 4 §5).
 *
 * The old naming took the single nearest OSM venue to the cluster
 * centroid. Where venues pack within GPS error that is a coin-flip, and
 * it ignores everything the cluster's visit history says about *what
 * kind* of place it is.
 *
 * This scores every nearby venue by
 *     score(v) = w_dist(v) · w_type(v) · w_name(v)
 * — soft distance falloff, type-plausibility against the visit pattern,
 * and a name cue that rescues mis-tagged venues. When the top two score
 * too close the result is flagged `ambiguous`: the caller should not
 * assert a confident (and probably wrong) name.
 *
 * Pure module — no DB, no I/O.
 */

import { localSolarHour, type Stay } from "./focus-places.js";
import type { NearbyLandmark } from "./osm.js";

/** Behavioural signature of a focus-place cluster — distilled to the
 *  few features that discriminate one venue kind from another. */
export interface VisitPattern {
	visitCount: number;
	/** Median stay duration, seconds. */
	medianDwellSec: number;
	/** Fraction of visits whose start falls in local 06:00–12:00. */
	morningFraction: number;
}

/** Coarse venue kind — the unit the type-plausibility table works in. */
type VenueKind = "linger" | "quick" | "clinical" | "evening" | "other";

/** OSM subtype → venue kind. Enumerated, not pattern-matched, so the
 *  mapping is auditable and easy to extend. */
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

/** Names that mark a place as a café whatever OSM tagged it — OSM
 *  routinely tags coffee shops as `fast_food`. A name cue overrides the
 *  subtype, so a mis-tagged café is not scored as a burger counter. */
const CAFE_NAME = /\b(coffee|caf[eé]|espresso|roaster)/i;

/** OSM `type`s that name an actual venue; place/highway are not venues. */
const VENUE_TYPES = new Set<NearbyLandmark["type"]>(["amenity", "tourism", "leisure", "shop"]);
/** σ of the soft distance falloff — roughly a converged cluster's
 *  positional uncertainty. A venue 2σ (30 m) out still scores ~14%. */
const DIST_SIGMA_M = 15;
/** Above this median dwell a stay is "lingering", not a quick stop. */
const LONG_DWELL_SEC = 45 * 60;
/** The top score must beat the runner-up by this factor to be asserted;
 *  otherwise the place is flagged ambiguous. */
const AMBIGUITY_MARGIN = 1.3;
/** A name-cue-confirmed venue edges an inferred one of equal geometry. */
const NAME_BOOST = 1.15;

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

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

/** Distil a cluster's stays into the features the namer scores against. */
export function clusterVisitPattern(stays: Stay[]): VisitPattern {
	if (stays.length === 0) return { visitCount: 0, medianDwellSec: 0, morningFraction: 0 };
	const morning = stays.filter((s) => {
		const h = localSolarHour(s.startTs, s.centroidLon);
		return h >= 6 && h < 12;
	}).length;
	return {
		visitCount: stays.length,
		medianDwellSec: median(stays.map((s) => s.durationSec)),
		morningFraction: morning / stays.length,
	};
}

function venueKind(c: NearbyLandmark): VenueKind {
	if (CAFE_NAME.test(c.name)) return "linger"; // a name cue overrides a mis-tag
	return SUBTYPE_KIND[c.subtype] ?? "other";
}

/** Plausibility that a venue of this kind is the place the cluster's
 *  visit pattern describes. Hand-tuned; 1.0 = a natural fit. */
function kindPlausibility(kind: VenueKind, p: VisitPattern): number {
	const longDwell = p.medianDwellSec >= LONG_DWELL_SEC;
	const morning = p.morningFraction >= 0.5;
	switch (kind) {
		case "linger":
			return longDwell ? 1.0 : 0.55;
		case "quick":
			return longDwell ? 0.25 : 1.0;
		case "clinical":
			// Nobody racks up many "frequent" dentist appointments.
			return p.visitCount >= 5 ? 0.1 : 0.5;
		case "evening":
			return morning ? 0.15 : 0.85;
		default:
			return 0.5;
	}
}

function distWeight(distanceM: number): number {
	return Math.exp(-(distanceM * distanceM) / (2 * DIST_SIGMA_M * DIST_SIGMA_M));
}

/**
 * Name a focus-place cluster by scoring every nearby OSM venue against
 * the cluster's converged position *and* its behavioural pattern,
 * instead of taking the single nearest node.
 */
export function nameCluster(candidates: NearbyLandmark[], pattern: VisitPattern): PlaceNaming {
	const ranked: ScoredCandidate[] = candidates
		.filter((c) => VENUE_TYPES.has(c.type))
		.map((c) => ({
			name: c.name,
			subtype: c.subtype,
			distanceM: c.distanceM,
			score:
				distWeight(c.distanceM) * kindPlausibility(venueKind(c), pattern) * (CAFE_NAME.test(c.name) ? NAME_BOOST : 1.0),
		}))
		.sort((a, b) => b.score - a.score);

	if (ranked.length === 0) return { label: null, ambiguous: false, ranked };
	const ambiguous = ranked.length > 1 && ranked[0].score / ranked[1].score < AMBIGUITY_MARGIN;
	return { label: ranked[0].name, ambiguous, ranked };
}
