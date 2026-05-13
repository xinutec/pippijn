/**
 * Candidate generator for `refineMode`.
 *
 * Minimum-viable Phase 1 generator (per
 * `docs/proposals/2026-05-scored-classification.md`): turns the
 * existing `NearbyWay[]` + segment's classifier `originalMode`
 * into a list of `ModeCandidate` for the factor aggregator.
 *
 * Design:
 *
 *   - For each NearbyWay, emit one candidate per *plausibly
 *     compatible* mode. A primary road is compatible with driving,
 *     walking, and cycling; a footway is compatible with walking
 *     only; a railway is compatible with train only; etc.
 *   - Always include a fallback candidate carrying `originalMode`
 *     with no way info, so the consumer never receives an empty list
 *     and the labeller falls back gracefully when no OSM way is in
 *     range (the "in the middle of an unmapped square" case).
 *   - The generator does NOT decide which candidate wins — that's
 *     the factor aggregator's job. The generator is dumb about
 *     speed and other context; it just enumerates the candidate
 *     space.
 *
 * Not handled here (intentionally):
 *
 *   - `annotateRailRuns` candidate enumeration (alternative
 *     boarding/alighting station pairs). Harder problem and
 *     today's rail-run rule fixes already constrain it; per the
 *     third opus review, defer until refineMode cutover is proven.
 *   - Boat / waterway modes — not in the production mode set yet.
 *     waterway ways are currently dropped.
 */

import type { ModeCandidate } from "./types.js";
import type { TransportMode } from "../segments.js";
import type { NearbyWay } from "../osm.js";

const DRIVEABLE_HIGHWAY_SUBTYPES = new Set([
	"motorway",
	"trunk",
	"primary",
	"secondary",
	"tertiary",
	"residential",
	"service",
	"unclassified",
	"track",
	"living_street",
]);
const PEDESTRIAN_HIGHWAY_SUBTYPES = new Set(["footway", "path", "pedestrian", "bridleway", "steps"]);

function modesForWay(way: NearbyWay): TransportMode[] {
	if (way.type === "railway") return ["train"];
	if (way.type === "aeroway") {
		if (way.subtype === "runway" || way.subtype === "taxiway") return ["plane"];
		return ["stationary"];
	}
	if (way.type === "highway") {
		if (way.subtype === "cycleway") return ["cycling"];
		if (PEDESTRIAN_HIGHWAY_SUBTYPES.has(way.subtype)) return ["walking"];
		if (DRIVEABLE_HIGHWAY_SUBTYPES.has(way.subtype)) return ["driving", "walking", "cycling"];
	}
	return [];
}

/**
 * Enumerate the plausible labelling space for one set of nearby ways.
 *
 * The returned list always contains at least the `originalMode`
 * fallback candidate (so downstream code can rely on a non-empty
 * result).
 */
export function generateRefineModeCandidates(
	originalMode: TransportMode,
	ways: readonly NearbyWay[],
): ModeCandidate[] {
	const candidates: ModeCandidate[] = [];
	for (const way of ways) {
		const modes = modesForWay(way);
		for (const mode of modes) {
			candidates.push({
				mode,
				wayName: way.name,
				waySubtype: way.subtype,
				wayDistanceM: way.distanceM,
			});
		}
	}
	// Fallback: the segment classifier's chosen mode with no way info.
	// Covers the "no useful way nearby" case and ensures the consumer
	// can always make a decision even if it's not particularly informed.
	candidates.push({ mode: originalMode });
	return candidates;
}
