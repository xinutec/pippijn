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

import { pedometerDistanceM } from "../eval/walk-score.js";
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
/** When a "walk" barely displaces — net end-to-end distance below this fraction
 *  of the pedometer distance — the steps were in-place pacing (pottering at a
 *  doorstep), not travel along a path. Forcing the PDR arc-length onto a tiny
 *  area would invent a wiggle, so PDR is dropped for the leg and the smoother
 *  falls back to robust GPS + smoothness (a compact line). */
const POTTER_NET_FRACTION = 0.45;
/** A smoothed walk up to this tortuosity is accepted even if the raw track was
 *  tighter — a clean walk is ≤ this, and we don't want to reject a perfectly
 *  good smoothed line just because the raw happened to be near-straight. Above
 *  it, the smoothed path must beat the raw's tortuosity to be kept. */
const GATE_TORTUOSITY_FLOOR = 1.5;

/** Drawn path length ÷ straight-line end-to-end (≥1). */
function tortuosity(pts: ReadonlyArray<{ lat: number; lon: number }>): number {
	if (pts.length < 2) return 1;
	let len = 0;
	for (let i = 1; i < pts.length; i++) len += metersBetween(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
	const straight = metersBetween(pts[0].lat, pts[0].lon, pts[pts.length - 1].lat, pts[pts.length - 1].lon);
	return straight > 1 ? len / straight : 1;
}
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

/** The most accurate fix within `halfWindow` s of `t` among `fixes`, or null.
 *  `fixes` must be the walk's OWN (speed-filtered) fixes — anchoring to a
 *  neighbouring *moving* leg's fix is wrong: a drive fix at the boundary is
 *  accurate but already tens of metres away (the car moved), which would
 *  stretch the walk to reach it. */
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

		// Anchor each end to the most reliable of the walk's OWN boundary fixes
		// (inWin is already speed-filtered, so a fast neighbour-leg fix can't be
		// chosen and stretch the walk to reach where the car had driven to).
		const a = bestFixNear(inWin, seg.startTs, ANCHOR_HALF_WINDOW_S);
		const b = bestFixNear(inWin, seg.endTs, ANCHOR_HALF_WINDOW_S);

		// Potter guard: if the walk barely displaces vs the steps taken, the
		// pedometer is in-place pacing, not travel — drop PDR so it can't invent
		// a wiggle. A genuine walk (net ≈ steps) keeps the distance constraint.
		const net = metersBetween(inWin[0].lat, inWin[0].lon, inWin[inWin.length - 1].lat, inWin[inWin.length - 1].lon);
		const ped = pedometerDistanceM(steps, seg.startTs, seg.endTs);
		const pdrSteps = ped > 1 && net < POTTER_NET_FRACTION * ped ? [] : steps;

		const result = smoothPedestrianTrajectory(inWin, {
			anchorStart: a ? { lat: a.lat, lon: a.lon } : null,
			anchorEnd: b ? { lat: b.lat, lon: b.lon } : null,
			steps: pdrSteps,
			walkable,
		});

		// Self-checking gate: keep the smoothed path only when it does NOT draw
		// a wigglier line than the raw track. A near-stationary potter (jittery
		// fixes the classifier called "walking") has no real path to recover —
		// forcing one just adds wiggle — so there the raw (compact) line wins.
		// Mirrors the road-match display gate: never make the drawn line worse.
		const keep = result !== null && tortuosity(result.path) <= Math.max(tortuosity(inWin), GATE_TORTUOSITY_FLOOR);
		out.push(keep && result ? { ...seg, smoothedPath: result.path } : seg);
	}
	return out;
}
