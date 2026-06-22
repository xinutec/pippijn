/**
 * Annotate walking segments with a physically-precise smoothed geometry
 * (`docs/proposals/2026-06-pedestrian-trajectory-smoother.md`).
 *
 * The map draws a walking leg as its raw GPS, which zig-zags (slow-walk GPS
 * velocity is noise) and jumps on the odd 150–230 m accuracy fix. This pass
 * runs the MAP trajectory smoother (`pedestrian-smooth.ts`) over each walk —
 * fusing robust GPS, the pedometer's distance, endpoint anchors, gait
 * smoothness, and a soft walkable-surface prior — and attaches the result as
 * `smoothedPath`; `episode-geometry` draws it as `kind:"smoothed"` and falls
 * back to the raw track when it is absent.
 *
 * Purely additive — like the road-match and rail-snap passes it never rewrites
 * the mode or the fixes, only adds display geometry. Reads the walkable network
 * through the `OsmAdapter` (record/replay), so it stays deterministic for
 * golden. With no walkable data (an old fixture) the map factor is simply off.
 */

import type { EnrichedSegment } from "./enriched-segment.js";
import type { FilteredPoint } from "./kalman.js";
import { MAX_SPEED_FOR_MODE } from "./mode-biometrics.js";
import type { OsmAdapter } from "./osm-adapter.js";
import { type PedFix, type PedStep, smoothPedestrianTrajectory, type WalkableGeo } from "./pedestrian-smooth.js";
import { effectiveMode } from "./segment-util.js";

/** A leg shorter than this many in-window fixes isn't worth smoothing. */
const MIN_LEG_FIXES = 4;
/** Walking speed cap (km/h). Fixes whose Kalman speed exceeds it are a faster
 *  neighbour's bleed (a train decelerating into the walk) and are dropped
 *  before smoothing — mirroring the raw-draw branch's speed-plausibility
 *  filter, so the smoothed walk covers only the genuine on-foot portion. */
const WALK_SPEED_CAP_KMH = MAX_SPEED_FOR_MODE.walking ?? 12;
/** Slack (m) added to a leg's fix-cloud radius when reading its walkable
 *  network, so the pavements just past the leg's extent are included. */
const WALK_QUERY_SLACK_M = 120;
/** Half-window (s) around each leg boundary to look for the most reliable fix
 *  to anchor that end to — captures the neighbouring drive's last fix / the
 *  dwell place's first fix, which pin where the walk really started/ended. */
const ANCHOR_HALF_WINDOW_S = 45;

function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/** The most accurate fix within `halfWindow` s of `t`, or null. */
function bestFixNear(fixes: readonly PedFix[], t: number, halfWindow: number): PedFix | null {
	let best: PedFix | null = null;
	for (const f of fixes) {
		if (Math.abs(f.ts - t) > halfWindow) continue;
		const acc = f.accuracy ?? Number.POSITIVE_INFINITY;
		if (!best || acc < (best.accuracy ?? Number.POSITIVE_INFINITY)) best = f;
	}
	return best;
}

/**
 * Attach `smoothedPath` to every walking segment the smoother can place. One
 * `walkableRoads` query per walk (at the leg's fix centroid). `displayFixes`
 * are the raw, un-snapped fixes WITH accuracy (the same set the raw renderer
 * draws); `steps` the per-minute pedometer. Returns a new array; the input is
 * not mutated.
 */
export async function annotateWalkSmoothing(
	segments: readonly EnrichedSegment[],
	displayFixes: readonly PedFix[],
	points: readonly FilteredPoint[],
	steps: readonly PedStep[],
	osm: OsmAdapter,
): Promise<EnrichedSegment[]> {
	// Kalman speed per fix-ts — the same speed signal the raw-draw branch
	// filters on (displayFixes carry accuracy, not speed). Drop a fix bleeding
	// in at vehicle pace before it reaches the smoother.
	const speedByTs = new Map(points.map((p) => [p.ts, p.speed_kmh]));
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		if (effectiveMode(seg) !== "walking") {
			out.push(seg);
			continue;
		}
		const inWin = displayFixes
			.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs && (speedByTs.get(f.ts) ?? 0) <= WALK_SPEED_CAP_KMH)
			.sort((a, b) => a.ts - b.ts);
		if (inWin.length < MIN_LEG_FIXES) {
			out.push(seg);
			continue;
		}

		// Walkable network around the leg centroid, sized to reach every fix.
		let sumLat = 0;
		let sumLon = 0;
		for (const f of inWin) {
			sumLat += f.lat;
			sumLon += f.lon;
		}
		const cLat = sumLat / inWin.length;
		const cLon = sumLon / inWin.length;
		let maxDist = 0;
		for (const f of inWin) {
			const d = metersBetween(cLat, cLon, f.lat, f.lon);
			if (d > maxDist) maxDist = d;
		}
		const radiusM = Math.round(maxDist + WALK_QUERY_SLACK_M);
		const ways = await osm.walkableRoads(cLat, cLon, radiusM);
		const walkable: WalkableGeo | null = ways.length > 0 ? { ways } : null;

		// Anchor each end to the most reliable fix near the boundary (often a
		// neighbour leg's stable fix — the drive's last, the dwell's first).
		const a = bestFixNear(displayFixes, seg.startTs, ANCHOR_HALF_WINDOW_S);
		const b = bestFixNear(displayFixes, seg.endTs, ANCHOR_HALF_WINDOW_S);

		const result = smoothPedestrianTrajectory(inWin, {
			anchorStart: a ? { lat: a.lat, lon: a.lon } : null,
			anchorEnd: b ? { lat: b.lat, lon: b.lon } : null,
			steps,
			walkable,
		});
		out.push(result ? { ...seg, smoothedPath: result.path } : seg);
	}
	return out;
}
