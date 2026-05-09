/**
 * Velocity pipeline: raw PhoneTrack GPS → Kalman filter → segment classification → OSM enrichment.
 *
 * Used by both the API route and the CLI tool.
 */

import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";
import type { FilteredPoint } from "./kalman.js";
import { filterGpsTrack } from "./kalman.js";
import { nearbyWays, placeLabel, refineMode, reverseGeocode } from "./osm.js";
import type { TrackSegment } from "./segments.js";
import { classifySegments } from "./segments.js";
import { dateBoundsUtc } from "./timezone.js";

export interface EnrichedSegment extends TrackSegment {
	place?: string; // human-readable place name (for stationary segments)
	wayName?: string; // road/rail name (for moving segments)
	refinedMode?: string; // OSM-refined transport mode (may differ from heuristic mode)
	refinedReason?: string;
}

export interface VelocityResult {
	points: FilteredPoint[];
	segments: EnrichedSegment[];
}

export async function computeVelocity(
	config: NextcloudConfig,
	userId: string,
	date: string,
	tz?: string,
	options: { enrich?: boolean } = {},
): Promise<VelocityResult> {
	const nextDay = (() => {
		const d = new Date(date);
		d.setDate(d.getDate() + 1);
		return d.toISOString().slice(0, 10);
	})();

	const bounds = dateBoundsUtc(date, tz);
	const raw = await fetchTrackPoints(config, userId, date, nextDay);

	const gpsPoints = raw
		.filter((p) => p.ts >= bounds.startUtc && p.ts < bounds.endUtc)
		.filter((p) => p.accuracy === null || p.accuracy <= 50)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));

	const points = filterGpsTrack(gpsPoints);
	const segments = classifySegments(points);

	if (options.enrich === false) {
		return { points, segments };
	}

	// Enrich each segment with OSM data
	const enriched: EnrichedSegment[] = await Promise.all(
		segments.map(async (seg) => {
			// Find points belonging to this segment for centroid calculation
			const segPoints = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
			if (segPoints.length === 0) return seg;

			const centroidLat = segPoints.reduce((s, p) => s + p.lat, 0) / segPoints.length;
			const centroidLon = segPoints.reduce((s, p) => s + p.lon, 0) / segPoints.length;

			try {
				if (seg.mode === "stationary") {
					// Reverse geocode the centroid
					const place = await reverseGeocode(centroidLat, centroidLon);
					return place ? { ...seg, place: placeLabel(place) } : seg;
				} else {
					// Find nearby ways to refine the mode
					const ways = await nearbyWays(centroidLat, centroidLon);
					const refined = refineMode(seg.mode, seg.avgSpeed, ways);
					return {
						...seg,
						refinedMode: refined.mode,
						refinedReason: refined.reason,
						wayName: refined.wayName,
					};
				}
			} catch (e) {
				console.warn(`OSM enrichment failed for segment ${seg.startTs}: ${e}`);
				return seg;
			}
		}),
	);

	return { points, segments: enriched };
}
