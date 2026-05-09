/**
 * Velocity pipeline: raw PhoneTrack GPS → Kalman filter → segment classification.
 *
 * Used by both the API route and the CLI tool.
 */

import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";
import type { FilteredPoint } from "./kalman.js";
import { filterGpsTrack } from "./kalman.js";
import type { TrackSegment } from "./segments.js";
import { classifySegments } from "./segments.js";
import { dateBoundsUtc } from "./timezone.js";

export interface VelocityResult {
	points: FilteredPoint[];
	segments: TrackSegment[];
}

export async function computeVelocity(
	config: NextcloudConfig,
	userId: string,
	date: string,
	tz?: string,
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

	return { points, segments };
}
