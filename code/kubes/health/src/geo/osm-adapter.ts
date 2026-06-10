/**
 * `OsmAdapter` — the input boundary for OSM and Nominatim lookups.
 *
 * Phase 6c of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * The classification pipeline reads OSM at points the loader cannot
 * predict in advance (segment shape, sample points, rail-run triggers,
 * sleep-window recursion all depend on pipeline-internal decisions).
 * Capturing those reads as a pre-loaded row-set means over-capture; a
 * day-bbox row-set was measured at 16 min/day in `ST_AsText`
 * serialisation alone. The right shape is an adapter interface:
 * production injects a DB-backed implementation; tests inject a
 * fixture-backed one; the pipeline calls the interface and stays
 * pure-given-the-adapter.
 *
 * Three implementations land across Phase 6c–6e:
 *
 *   - `DbOsmAdapter` (Phase 6c, this file) — delegates to the
 *     existing top-level functions in `osm.ts`. Production.
 *   - `RecordingOsmAdapter` (Phase 6e) — wraps another adapter,
 *     records each call's returned rows + Nominatim responses for
 *     fixture capture.
 *   - `FixtureOsmAdapter` (Phase 6e) — answers OSM queries by
 *     filtering the captured row-set via the pure helpers in
 *     `osm-pure.ts`; answers `reverseGeocode` by exact-key lookup.
 *
 * Phase 6c only adds the interface and the DB delegate. velocity.ts
 * call sites are migrated to consume `inputs.osm.X(...)` in Phase 6d.
 */

import {
	linesAtPoint,
	type NearbyLandmark,
	type NearbyStation,
	type NearbyTransitStop,
	type NearbyWay,
	type NominatimResult,
	nearbyLandmarks,
	nearbyStations,
	nearbyTransitStops,
	nearbyWays,
	reverseGeocode,
} from "./osm.js";

/** The OSM + Nominatim lookups the classification pipeline reads.
 *
 *  Surface matches the existing top-level functions in `osm.ts` 1:1,
 *  so the production wrapper is a trivial delegate. New OSM lookups
 *  added to the pipeline land here too, and Phase 6e's recording /
 *  fixture adapters pick them up the same way. */
export interface OsmAdapter {
	nearbyWays(lat: number, lon: number, radiusM?: number): Promise<NearbyWay[]>;
	nearbyStations(lat: number, lon: number, radiusM?: number): Promise<NearbyStation[]>;
	nearbyLandmarks(lat: number, lon: number, radiusM?: number): Promise<NearbyLandmark[]>;
	linesAtPoint(lat: number, lon: number, radiusM?: number): Promise<Set<string>>;
	reverseGeocode(lat: number, lon: number, zoom?: number): Promise<NominatimResult | null>;
	/** Bus stops + traffic signals near a point (task #247). */
	nearbyTransitStops(lat: number, lon: number, radiusM?: number): Promise<NearbyTransitStop[]>;
}

/** Production adapter: delegate to the existing top-level functions
 *  in `osm.ts`. Behaviour is byte-identical to pre-Phase-6c — same
 *  `ensureCovered` calls, same MariaDB spatial queries, same
 *  Nominatim HTTP + cache path. */
export const dbOsmAdapter: OsmAdapter = {
	nearbyWays,
	nearbyStations,
	nearbyLandmarks,
	linesAtPoint,
	reverseGeocode,
	nearbyTransitStops,
};
