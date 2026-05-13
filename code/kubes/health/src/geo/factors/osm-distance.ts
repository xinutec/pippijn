/**
 * osm-distance factor.
 *
 * Scores each candidate by how close its chosen OSM way is to the
 * GPS trajectory. Different candidates point at different ways (a
 * "train on Tube line X" candidate looks at distance to a rail
 * polyline; a "driving on road Y" candidate looks at distance to a
 * highway polyline) — so the distance lives ON the candidate, set
 * by the candidate generator.
 *
 * This factor absorbs today's rule-cascade fixes:
 *
 *   - distance-aware rail-vs-road tie-break: when both train and
 *     driving candidates are available, the closer one wins via the
 *     factor sum.
 *   - driveable-vs-footway preference: combined with mode-coherence,
 *     a closer footway gets penalised when the segment is clearly
 *     vehicular.
 *
 * Mathematical shape: `-log(max(distance, MIN_M) / REF_M)` in nats.
 *
 *   - At REF_M (10m), score is 0 — the "expected" GPS-to-feature
 *     offset given typical urban GPS accuracy.
 *   - Closer than REF_M gives a small positive bonus.
 *   - The MIN_M floor (1m) prevents distance=0 from producing
 *     `+Infinity` and dominating the candidate's total score.
 *   - Logarithmic falloff: doubling distance subtracts ~0.69 nats.
 *     A candidate at 100m loses ~2.3 nats relative to a candidate
 *     at 10m, which is significant but not annihilating.
 *
 * Calibration of REF_M is a Phase 2 / Phase 3 task. 10m is a
 * defensible default for urban GPS with city-block-scale features.
 */

import type { Factor } from "./types.js";

const REFERENCE_DISTANCE_M = 10;
const MIN_DISTANCE_M = 1;

export const osmDistance: Factor = (candidate, _ctx) => {
	const d = candidate.wayDistanceM;
	if (d === undefined || d === null || !Number.isFinite(d)) return null;
	const clamped = Math.max(d, MIN_DISTANCE_M);
	const score = -Math.log(clamped / REFERENCE_DISTANCE_M);
	return {
		name: "osm-distance",
		score,
		rationale: rationaleFor(candidate.wayName, d),
	};
};

function rationaleFor(wayName: string | undefined, distance: number): string {
	const what = wayName ?? "way";
	if (distance < 5) return `essentially on ${what} (${Math.round(distance)}m)`;
	if (distance < 30) return `near ${what} (${Math.round(distance)}m)`;
	return `${Math.round(distance)}m from ${what}`;
}
