/**
 * Velocity pipeline: raw PhoneTrack GPS → Kalman filter → segment classification → OSM enrichment.
 *
 * Used by both the API route and the CLI tool.
 */

import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";
import type { FilteredPoint } from "./kalman.js";
import { filterGpsTrack } from "./kalman.js";
import { bestPlace, nearbyWays, placeLabel, refineMode } from "./osm.js";
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

	const N_SAMPLES = 5;

	// Enrich each segment with OSM data
	const enriched: EnrichedSegment[] = await Promise.all(
		segments.map(async (seg) => {
			const segPoints = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
			if (segPoints.length === 0) return seg;

			try {
				if (seg.mode === "stationary") {
					// One place — geocode the centroid (two-zoom: building, then area).
					const cLat = segPoints.reduce((s, p) => s + p.lat, 0) / segPoints.length;
					const cLon = segPoints.reduce((s, p) => s + p.lon, 0) / segPoints.length;
					const place = await bestPlace(cLat, cLon);
					return place ? { ...seg, place: placeLabel(place) } : seg;
				}
				// Moving segment: sample several points along the path so the
				// OSM evidence reflects the whole route, not whatever the
				// centroid happens to land on.
				const sampleCount = Math.min(N_SAMPLES, segPoints.length);
				const sampleIdxs = Array.from({ length: sampleCount }, (_, i) =>
					Math.floor((i * (segPoints.length - 1)) / Math.max(1, sampleCount - 1)),
				);
				const wayResults = await Promise.all(
					sampleIdxs.map((i) => nearbyWays(segPoints[i].lat, segPoints[i].lon)),
				);
				const seen = new Set<string>();
				const aggregated = [];
				for (const ways of wayResults) {
					for (const w of ways) {
						const key = `${w.type}/${w.subtype}/${w.name ?? ""}`;
						if (!seen.has(key)) {
							seen.add(key);
							aggregated.push(w);
						}
					}
				}
				const refined = refineMode(seg.mode, seg.avgSpeed, aggregated);
				return {
					...seg,
					refinedMode: refined.mode,
					refinedReason: refined.reason,
					wayName: refined.wayName,
				};
			} catch (e) {
				console.warn(`OSM enrichment failed for segment ${seg.startTs}: ${e}`);
				return seg;
			}
		}),
	);

	return { points, segments: enriched };
}
