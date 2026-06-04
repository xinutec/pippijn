/**
 * Pure spatial queries over an in-memory OSM snapshot.
 *
 * Phase 6a of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * The production pipeline reaches into `osm_lines` / `osm_points`
 * per-sample, per-segment via `nearbyWays` / `nearbyStations` — each
 * call hits the DB (or Overpass on a cold miss). For deterministic
 * tests, we need the same lookups to be pure functions of a captured
 * snapshot.
 *
 * The split:
 *
 *   - `OsmSnapshot`        — the loaded rows for the day's bbox
 *                            (pre-parsed geometry so the per-call hot
 *                            path skips WKT decoding)
 *   - `nearbyWaysInSnapshot`     — pure equivalent of `nearbyWays`
 *   - `nearbyStationsInSnapshot` — pure equivalent of `nearbyStations`
 *
 * The math kernel (equirectangular-projection point-to-segment) is
 * the same one MariaDB approximates and the same one used by
 * `pointToLineDistanceM` in `line-stations.ts`. Behaviour should
 * match the DB path to sub-percent at city-scale distances.
 *
 * This module does NOT touch the DB and does not need a connection.
 * Phase 6b will populate the snapshot from the DB at request time
 * (or from a fixture at test time); Phase 6d will migrate
 * `computeVelocity` call sites to consume it.
 */

import { pointToLineDistanceMParsed } from "./line-stations.js";
import { dedupeStationsByName, type NearbyStation, type NearbyWay } from "./osm.js";
import { haversineMeters } from "./place-snap.js";

/** A LINESTRING-shaped OSM row, with its geometry pre-parsed to a
 *  flat `[lat, lon]` pair list. Mirrors the columns the existing
 *  `queryLines` projects + the same parser `pointToLineDistanceM`
 *  uses. */
export interface OsmSnapshotLine {
	/** `feature_type`: "highway" | "railway" | "waterway" | "aeroway". */
	featureType: string;
	subtype: string | null;
	name: string | null;
	/** Pre-parsed polyline as `[lat, lon]` pairs. */
	geometry: ReadonlyArray<readonly [number, number]>;
}

/** A POINT-shaped OSM row. Same field list as `OsmSnapshotLine`
 *  but with a single coordinate and the raw OSM tags (which the
 *  station-subtype derivation in `nearbyStations` inspects). */
export interface OsmSnapshotPoint {
	featureType: string;
	subtype: string | null;
	name: string | null;
	lat: number;
	lon: number;
	tags: Record<string, string>;
}

/** Day-bbox closure of OSM rows the pipeline reads. */
export interface OsmSnapshot {
	lines: ReadonlyArray<OsmSnapshotLine>;
	points: ReadonlyArray<OsmSnapshotPoint>;
}

/** Pure equivalent of `nearbyWays` from `src/geo/osm.ts`.
 *
 *  Same shape as the DB-backed version:
 *    - 4 line feature_types: highway, railway, waterway, aeroway
 *    - aeroway also queried as points (airports tagged as nodes)
 *    - flat NearbyWay output with distance per match
 *
 *  Distance kernel matches `pointToLineDistanceM` — the same
 *  equirectangular projection used by `MariaDB ST_Distance`. */
export function nearbyWaysInSnapshot(snapshot: OsmSnapshot, lat: number, lon: number, radiusM = 50): NearbyWay[] {
	const ways: NearbyWay[] = [];
	const LINE_TYPES = new Set(["highway", "railway", "waterway", "aeroway"]);
	for (const line of snapshot.lines) {
		if (!LINE_TYPES.has(line.featureType)) continue;
		const d = pointToLineDistanceMParsed(lat, lon, line.geometry);
		if (d > radiusM) continue;
		ways.push({
			type: line.featureType,
			subtype: line.subtype ?? "",
			name: line.name ?? undefined,
			distanceM: d,
		});
	}
	for (const p of snapshot.points) {
		if (p.featureType !== "aeroway") continue;
		const d = haversineMeters(lat, lon, p.lat, p.lon);
		if (d > radiusM) continue;
		ways.push({
			type: p.featureType,
			subtype: p.subtype ?? "",
			name: p.name ?? undefined,
			distanceM: d,
		});
	}
	return ways;
}

/** Pure equivalent of `nearbyStations` from `src/geo/osm.ts`.
 *
 *  Filters railway-feature points by station-like subtype, computes
 *  Haversine distance, derives the station subtype from tags (same
 *  rule as production), and collapses duplicates by name keeping
 *  the closest. */
export function nearbyStationsInSnapshot(
	snapshot: OsmSnapshot,
	lat: number,
	lon: number,
	radiusM = 200,
): NearbyStation[] {
	const STATION_SUBTYPES = new Set(["station", "subway_entrance", "halt", "stop", "tram_stop"]);
	const features: Array<{ name: string | null; derivedSubtype: string; distance_m: number }> = [];
	for (const p of snapshot.points) {
		if (p.featureType !== "railway") continue;
		if (p.subtype === null || !STATION_SUBTYPES.has(p.subtype)) continue;
		const d = haversineMeters(lat, lon, p.lat, p.lon);
		if (d > radiusM) continue;
		features.push({
			name: p.name,
			derivedSubtype: deriveStationSubtype(p),
			distance_m: d,
		});
	}
	return dedupeStationsByName(features);
}

/** Mirror of the private `deriveStationSubtype` in `osm.ts`. Same
 *  rule set, in the same order. Tested in
 *  `tests/osm-pure.test.ts` against the canonical OSM tag patterns. */
function deriveStationSubtype(p: OsmSnapshotPoint): string {
	if (p.subtype === "subway_entrance") return "subway_entrance";
	if (p.tags.station === "subway") return "subway";
	if (p.tags.station === "light_rail") return "light_rail";
	if (p.tags.tram === "yes" || p.subtype === "tram_stop") return "tram";
	if (p.subtype === "halt") return "halt";
	return "rail";
}
