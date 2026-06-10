/**
 * `FixtureOsmAdapter` — answers `OsmAdapter` calls from a pre-captured
 * `OsmTrace`. The replay side of Phase 6e of
 * `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * Pairs with `RecordingOsmAdapter`: a `capture-day-v2` run wraps
 * `DbOsmAdapter` with the recorder, executes the pipeline, and
 * serialises the trace to disk. A `golden-check-v2` run loads the
 * trace, wraps it with `FixtureOsmAdapter`, and replays the pipeline.
 *
 * Replay is exact-key: the pipeline must call each primitive at
 * exactly the (lat, lon, radius) the recorder saw. Uncaptured queries
 * throw — that is the deliberate-capture property the proposal
 * promises. A pipeline code change that adds or moves a call site
 * surfaces here, not in the diff against `expected.velocity`, which
 * points the developer at the actual cause.
 */

import type { NearbyLandmark, NearbyStation, NearbyTransitStop, NearbyWay, NominatimResult } from "./osm.js";
import type { OsmAdapter } from "./osm-adapter.js";
import type { OsmTrace } from "./osm-adapter-recording.js";

function key3(lat: number, lon: number, third: number | undefined): string {
	return `${lat}|${lon}|${third ?? ""}`;
}

/** Replays adapter calls from a captured `OsmTrace`. Throws on any
 *  call whose (lat, lon, radius) is not present in the trace. */
export class FixtureOsmAdapter implements OsmAdapter {
	constructor(private readonly trace: OsmTrace) {}

	async nearbyWays(lat: number, lon: number, radiusM?: number): Promise<NearbyWay[]> {
		const result = this.trace.nearbyWays[key3(lat, lon, radiusM)];
		if (result === undefined) {
			throw new Error(`FixtureOsmAdapter: uncaptured nearbyWays(${lat}, ${lon}, ${radiusM}) — re-capture required`);
		}
		return result;
	}

	async nearbyStations(lat: number, lon: number, radiusM?: number): Promise<NearbyStation[]> {
		const result = this.trace.nearbyStations[key3(lat, lon, radiusM)];
		if (result === undefined) {
			throw new Error(`FixtureOsmAdapter: uncaptured nearbyStations(${lat}, ${lon}, ${radiusM}) — re-capture required`);
		}
		return result;
	}

	async nearbyLandmarks(lat: number, lon: number, radiusM?: number): Promise<NearbyLandmark[]> {
		const result = this.trace.nearbyLandmarks[key3(lat, lon, radiusM)];
		if (result === undefined) {
			throw new Error(
				`FixtureOsmAdapter: uncaptured nearbyLandmarks(${lat}, ${lon}, ${radiusM}) — re-capture required`,
			);
		}
		return result;
	}

	async linesAtPoint(lat: number, lon: number, radiusM?: number): Promise<Set<string>> {
		const result = this.trace.linesAtPoint[key3(lat, lon, radiusM)];
		if (result === undefined) {
			throw new Error(`FixtureOsmAdapter: uncaptured linesAtPoint(${lat}, ${lon}, ${radiusM}) — re-capture required`);
		}
		return new Set(result);
	}

	async reverseGeocode(lat: number, lon: number, zoom?: number): Promise<NominatimResult | null> {
		const k = key3(lat, lon, zoom);
		if (!(k in this.trace.reverseGeocode)) {
			throw new Error(`FixtureOsmAdapter: uncaptured reverseGeocode(${lat}, ${lon}, ${zoom}) — re-capture required`);
		}
		return this.trace.reverseGeocode[k];
	}

	async nearbyTransitStops(lat: number, lon: number, radiusM?: number): Promise<NearbyTransitStop[]> {
		// Fixtures captured before task #247 have no transit-stop section
		// at all — replay them as "no transit-stop data" rather than
		// failing every old golden. A PRESENT section with a missing key
		// is the normal uncaptured-query error.
		const section = this.trace.nearbyTransitStops;
		if (section === undefined) return [];
		const result = section[key3(lat, lon, radiusM)];
		if (result === undefined) {
			throw new Error(
				`FixtureOsmAdapter: uncaptured nearbyTransitStops(${lat}, ${lon}, ${radiusM}) — re-capture required`,
			);
		}
		return result;
	}
}
