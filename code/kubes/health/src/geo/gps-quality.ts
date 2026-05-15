/**
 * GPS quality-control pre-filter.
 *
 * Runs before the Kalman filter. Its job is *quality control* — deciding
 * which raw fixes are real — kept strictly separate from *smoothing*
 * (the Kalman filter) and *gap handling* (`inferTransitGaps`).
 *
 * Why it exists: underground (tube, deep buildings) the phone falls back
 * to cell-tower triangulation and emits positions that are wrong, not
 * just noisy — teleporting kilometres and back within seconds. No
 * smoothing filter recovers a true trajectory from that; the information
 * isn't there. The honest move is to discard the incoherent run and let
 * downstream gap-inference treat the tunnel as missing data (which it
 * already does for above-ground GPS gaps).
 *
 * Algorithm — anchor walk:
 *   - Keep an "anchor": the last fix accepted as real.
 *   - A candidate fix reachable from the anchor at a plausible speed
 *     (<= SPEED_CEILING_KMH) is kept and becomes the new anchor.
 *   - A candidate that is NOT reachable starts a suspected garbage run.
 *     Scan forward for the first later fix that IS reachable from the
 *     anchor — that's the surfacing point. Drop everything between.
 *   - If no bridge exists within BRIDGE_WINDOW_S, the run is genuine
 *     sustained fast travel (plane, high-speed rail): a garbage spike
 *     always has a return fix reachable from the pre-spike anchor,
 *     whereas a plane keeps moving away. Keep the fix and trust it.
 *
 * Magnitude alone cannot separate garbage from a plane — a 480 km/h
 * teleport is *slower* than an 800 km/h plane. Coherence is the
 * separator, and the bridge scan is how this filter tests it: garbage
 * is a detour (there's a reachable fix on the far side); fast travel
 * is not.
 */

import type { GpsPoint } from "./kalman.js";

/** Max plausible point-to-point speed for a fix to count as "reachable"
 *  from the anchor. Covers every ground mode the data realistically
 *  contains — urban driving, motorway, conventional rail (~120 km/h).
 *  High-speed rail and aircraft exceed it; those fall through to the
 *  no-bridge "keep" path, which is correct (they're coherent travel). */
const SPEED_CEILING_KMH = 150;

/** How far ahead to scan for a bridge fix. A garbage run longer than
 *  this (a very long tube journey with no usable GPS the whole way)
 *  exhausts the scan; the fix is then kept as a best-effort fallback.
 *  30 min comfortably covers a typical underground interchange. */
const BRIDGE_WINDOW_S = 30 * 60;

function impliedSpeedKmh(a: GpsPoint, b: GpsPoint): number {
	const dt = b.ts - a.ts;
	if (dt <= 0) return 0; // duplicate / out-of-order ts: treat as reachable
	const dLatM = (b.lat - a.lat) * 111_320;
	const dLonM = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
	const distM = Math.sqrt(dLatM ** 2 + dLonM ** 2);
	return (distM / dt) * 3.6;
}

/**
 * Drop physically-incoherent runs of GPS fixes (underground / cell-tower
 * garbage). Returns the surviving fixes in input order; dropped fixes
 * leave an honest temporal gap for downstream gap-inference.
 */
export function qualityFilterGps(points: GpsPoint[]): GpsPoint[] {
	if (points.length <= 2) return points;

	const kept: GpsPoint[] = [points[0]];
	let i = 1;
	while (i < points.length) {
		const anchor = kept[kept.length - 1];
		const cand = points[i];

		if (impliedSpeedKmh(anchor, cand) <= SPEED_CEILING_KMH) {
			kept.push(cand);
			i++;
			continue;
		}

		// `cand` is unreachable from the anchor. Scan forward for the
		// surfacing point on the far side of a garbage run. A valid
		// bridge must be both reachable from the anchor AND the start
		// of a coherent run (its own successor reachable from it) —
		// otherwise a garbage fix that is *coincidentally* reachable
		// (a few km from the anchor, but enough elapsed time that the
		// average speed looks plausible) would be mistaken for the
		// surfacing point.
		let bridge = -1;
		for (let j = i + 1; j < points.length && points[j].ts - anchor.ts <= BRIDGE_WINDOW_S; j++) {
			if (impliedSpeedKmh(anchor, points[j]) > SPEED_CEILING_KMH) continue;
			const coherentSuccessor =
				j + 1 >= points.length || impliedSpeedKmh(points[j], points[j + 1]) <= SPEED_CEILING_KMH;
			if (coherentSuccessor) {
				bridge = j;
				break;
			}
		}

		if (bridge >= 0) {
			// points[i .. bridge-1] are a garbage run — drop them.
			kept.push(points[bridge]);
			i = bridge + 1;
		} else {
			// No bridge: genuine sustained fast travel. Keep the fix.
			kept.push(cand);
			i++;
		}
	}
	return kept;
}
