/**
 * Velocity pipeline: raw PhoneTrack GPS → Kalman filter → segment classification → OSM enrichment.
 *
 * Used by both the API route and the CLI tool.
 */

import { db } from "../db/pool.js";
import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";
import { localSolarHour } from "./focus-places.js";
import type { FilteredPoint } from "./kalman.js";
import { filterGpsTrack } from "./kalman.js";
import { bestPlace, nearbyWays, placeLabel, refineMode } from "./osm.js";
import { type KnownPlace, snapToPlace } from "./place-snap.js";
import type { TrackSegment } from "./segments.js";
import { classifySegments } from "./segments.js";
import { dateBoundsUtc } from "./timezone.js";

/** Returns true if the segment includes ≥1 hour of local overnight time
 *  (00:00–06:00 in the segment's local solar time). Used to decide whether
 *  to prefer a residential address over a nearby amenity at the same coords. */
function hasOvernightPresence(startTs: number, endTs: number, lon: number): boolean {
	const stepSec = 30 * 60;
	let overnight = 0;
	for (let t = startTs; t <= endTs; t += stepSec) {
		const h = localSolarHour(t, lon);
		if (h >= 0 && h < 6) overnight += stepSec / 3600;
	}
	return overnight >= 1;
}

interface NamedPlace extends KnownPlace {
	displayName: string | null;
}

async function loadKnownPlaces(userId: string): Promise<NamedPlace[]> {
	const rows = await db()
		.selectFrom("focus_places")
		.select(["id", "centroid_lat", "centroid_lon", "radius_m", "display_name"])
		.where("user_id", "=", userId)
		.execute();
	return rows.map((r) => ({
		id: r.id,
		centroidLat: Number(r.centroid_lat),
		centroidLon: Number(r.centroid_lon),
		radiusM: r.radius_m,
		displayName: r.display_name,
	}));
}

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
	const inDay = raw.filter((p) => p.ts >= bounds.startUtc && p.ts < bounds.endUtc);

	// Place-snap: if a fix is unambiguously close to a known cluster (home,
	// work, etc.), pull it to the cluster centroid. Reduces GPS noise around
	// well-known locations and stabilises both segment timing and labels.
	const knownPlaces = await loadKnownPlaces(userId);
	const snapped =
		knownPlaces.length > 0
			? inDay.map((p) => {
					const r = snapToPlace({ lat: p.lat, lon: p.lon, accuracy: p.accuracy }, knownPlaces);
					return r.snapped ? { ...p, lat: r.lat, lon: r.lon, accuracy: r.accuracy } : p;
				})
			: inDay;

	// Tight filter (≤50m) for movement classification — Kalman-quality data only.
	const gpsPoints = snapped
		.filter((p) => p.accuracy === null || p.accuracy <= 50)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));

	// Loose filter (≤200m) for stay detection — indoor GPS often degrades
	// well past 50m but is still good enough to know you were "around here".
	const stayPoints = snapped
		.filter((p) => p.accuracy === null || p.accuracy <= 200)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon }));

	const points = filterGpsTrack(gpsPoints);
	const segments = classifySegments(points, stayPoints);

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
					let cLat = segPoints.reduce((s, p) => s + p.lat, 0) / segPoints.length;
					let cLon = segPoints.reduce((s, p) => s + p.lon, 0) / segPoints.length;

					// Stay-centroid snap: long stays accumulate centroid drift past the
					// per-fix snap radius. Re-snap the segment centroid against known
					// places with a generous radius so we recover from overnight drift.
					if (knownPlaces.length > 0) {
						const r = snapToPlace({ lat: cLat, lon: cLon, accuracy: 200 }, knownPlaces, {
							snapRadiusM: 100,
							minAccuracyToSnapM: 0,
						});
						if (r.snapped) {
							cLat = r.lat;
							cLon = r.lon;
							const matched = knownPlaces.find((p) => p.id === r.snappedTo?.id) as NamedPlace | undefined;
							if (matched?.displayName) {
								// Skip the OSM lookup entirely for known-named places.
								return { ...seg, place: matched.displayName };
							}
						}
					}

					const preferResidential = hasOvernightPresence(seg.startTs, seg.endTs, cLon);
					const place = await bestPlace(cLat, cLon, { preferResidential });
					return place ? { ...seg, place: placeLabel(place) } : seg;
				}
				// Moving segment: sample several points along the path so the
				// OSM evidence reflects the whole route, not whatever the
				// centroid happens to land on.
				const sampleCount = Math.min(N_SAMPLES, segPoints.length);
				const sampleIdxs = Array.from({ length: sampleCount }, (_, i) =>
					Math.floor((i * (segPoints.length - 1)) / Math.max(1, sampleCount - 1)),
				);
				const wayResults = await Promise.all(sampleIdxs.map((i) => nearbyWays(segPoints[i].lat, segPoints[i].lon)));
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

	return { points, segments: mergeAdjacentStays(enriched) };
}

/**
 * Merge two consecutive stationary segments that resolved to the same `place`
 * label and are separated by ≤ 5 min. Reflects the user's intent: a brief
 * pause that lands inside the same venue should read as one stay, not two.
 *
 * Chains (A, A, A) collapse into one. We deliberately do NOT collapse across
 * a real movement segment yet — keeps the post-step trivially correct.
 */
export function mergeAdjacentStays(segments: EnrichedSegment[]): EnrichedSegment[] {
	const result: EnrichedSegment[] = [];
	for (const seg of segments) {
		const prev = result[result.length - 1];
		if (
			prev &&
			prev.mode === "stationary" &&
			seg.mode === "stationary" &&
			prev.place &&
			prev.place === seg.place &&
			seg.startTs - prev.endTs <= 5 * 60
		) {
			prev.endTs = seg.endTs;
			prev.pointCount += seg.pointCount;
		} else {
			result.push({ ...seg });
		}
	}
	return result;
}
