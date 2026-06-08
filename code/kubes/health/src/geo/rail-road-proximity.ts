/**
 * Rail-vs-road proximity from OSM `nearbyWays` — the single source of
 * truth for "is this fix on the track or on a road".
 *
 * The velocity layer already uses this distinction per moving segment
 * (`computeRailRoadProximity` / `computeRoadNearestFraction`, #234) to
 * keep a road-following taxi off a parallel rail line. This module lifts
 * the same classification to a single fix, so the HSMM's per-minute
 * line-proximity factor can make the same call at decode time (#238) —
 * the decoder never credits a tube line to a fix that hugs a road.
 *
 * Pure given the `nearbyWays` results; the async helper is a thin loop
 * over an `OsmAdapter` so the caller can record/replay it through the
 * deterministic-fixtures adapter.
 */

import type { NearbyWay } from "./osm.js";
import type { OsmAdapter } from "./osm-adapter.js";

/** Rail-only OSM way subtypes — trams excluded (mixed-traffic track is
 *  not strong rail-vs-road evidence). Matches `velocity.ts`. */
export const RAIL_ONLY_SUBTYPES: ReadonlySet<string> = new Set(["rail", "subway", "light_rail", "narrow_gauge"]);

/** Drivable highway subtypes — residential through motorway plus
 *  track / living_street; pedestrian / cycle ways excluded. Matches the
 *  candidate generator's `DRIVEABLE_HIGHWAY_SUBTYPES` and `velocity.ts`. */
export const DRIVABLE_HIGHWAY_SUBTYPES: ReadonlySet<string> = new Set([
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

/** Query radius (m) for the HSMM per-fix proximity. Wider than the
 *  line-proximity factor's NEAR_M (250) so that when a fix is "near"
 *  line L by the route graph, the rail way is also in range here and
 *  the road-vs-rail comparison is meaningful rather than null. */
export const PROXIMITY_RADIUS_M = 300;

/** Distance (m) from a fix to the nearest rail-only way and to the
 *  nearest drivable road, given that fix's `nearbyWays` list. Null for a
 *  kind with nothing in range. Pure. */
export function railRoadDistFromWays(ways: readonly NearbyWay[]): {
	railDistM: number | null;
	roadDistM: number | null;
} {
	let minRail = Number.POSITIVE_INFINITY;
	let minRoad = Number.POSITIVE_INFINITY;
	for (const w of ways) {
		const d = w.distanceM;
		if (d === null || d === undefined || !Number.isFinite(d)) continue;
		if (w.type === "railway" && RAIL_ONLY_SUBTYPES.has(w.subtype)) {
			if (d < minRail) minRail = d;
		} else if (w.type === "highway" && DRIVABLE_HIGHWAY_SUBTYPES.has(w.subtype)) {
			if (d < minRoad) minRoad = d;
		}
	}
	return {
		railDistM: Number.isFinite(minRail) ? minRail : null,
		roadDistM: Number.isFinite(minRoad) ? minRoad : null,
	};
}

/** Per-fix rail/road proximity for a set of fixes, keyed by fix `ts`.
 *  One `nearbyWays` lookup per fix (the adapter caches by coarse
 *  coordinate, so clustered fixes collapse). Used by the HSMM loader to
 *  populate `Observation.roadDistM` / `railDistM`. */
export async function computePointProximity(
	osm: OsmAdapter,
	points: readonly { ts: number; lat: number; lon: number }[],
): Promise<Map<number, { railDistM: number | null; roadDistM: number | null }>> {
	const out = new Map<number, { railDistM: number | null; roadDistM: number | null }>();
	for (const p of points) {
		const ways = await osm.nearbyWays(p.lat, p.lon, PROXIMITY_RADIUS_M);
		out.set(p.ts, railRoadDistFromWays(ways));
	}
	return out;
}
