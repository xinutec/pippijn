/**
 * Annotate walking segments with a pavement-matched geometry — the pedestrian
 * analogue of `annotateRoadMatches` (#261), the proper fix for walks cutting
 * across buildings (#265 / `map-constrained-positioning`).
 *
 * The map draws a walking leg as the soft-smoothed line (`pedestrian-smooth.ts`),
 * which denoises GPS but never map-matches — on house-lined residential streets
 * the line sits where the raw GPS sits, ~10-30 m off the pavement, clipping the
 * houses. This pass reads the OSM walkable network around each walk (through the
 * `OsmAdapter`, so it records/replays deterministically like the rail/road/bus
 * passes) and runs the pedestrian matcher (`pedestrian-match.ts`) to snap the leg
 * onto the pavement/footway network. The result is attached as `walkMatchedPath`;
 * `episode-geometry` draws it as `kind:"matched"`, above `smoothedPath`.
 *
 * The query key (centroid + radius) is IDENTICAL to `annotateWalkSmoothing`'s, so
 * the `walkableRoads` lookup hits a key the golden fixtures already captured — no
 * re-capture. Purely additive: never rewrites mode or fixes, only adds display
 * geometry. The matcher's honest `null` (off-network / fragmented graph) leaves
 * `walkMatchedPath` undefined and the smoother's line draws instead.
 */

import type { EnrichedSegment } from "./enriched-segment.js";
import { rejectSpikes } from "./episode-geometry.js";
import type { FilteredPoint } from "./kalman.js";
import { matchImprovesDisplay, type RoadFix } from "./map-match-core.js";
import { MAX_SPEED_FOR_MODE } from "./mode-biometrics.js";
import type { OsmAdapter } from "./osm-adapter.js";
import { matchWalkSegment } from "./pedestrian-match.js";
import type { PedFix } from "./pedestrian-smooth.js";
import { effectiveMode } from "./segment-util.js";

/** Mirror `annotateWalkSmoothing`'s per-leg constants exactly, so the
 *  `walkableRoads` query key is identical and no golden re-capture is needed. */
const MIN_LEG_FIXES = 4;
const WALK_SPEED_CAP_KMH = MAX_SPEED_FOR_MODE.walking ?? 12;
const WALK_QUERY_SLACK_M = 120;

/** Confidence gate, judged on the DRAWN LINE (chords) like the road matcher,
 *  but against the WALKABLE network. Use the match only when the raw chords stray
 *  > {@link WALK_NEEDS_MATCH_M} off the walkable surface, the match follows it
 *  better, AND the match stays within {@link WALK_MATCH_MAX_STRAY_M} (p85) of the
 *  fixes. The stray cap is GENEROUS (40 m, like road): a walker's GPS genuinely
 *  sits 10-30 m off the pavement (houses / urban canyon), so the on-pavement
 *  match is legitimately that far from the fixes — measured p85 stray was 26-34 m
 *  on the 2026-06-24 walks while the match was clearly correct (off-road 67→9,
 *  38→7). A tight cap rejected exactly the good matches. The matcher's own tight
 *  20 m radius + corridor penalty are what bound a wrong-parallel-pavement snap;
 *  the stray cap only catches a gross mis-snap. */
const WALK_NEEDS_MATCH_M = 18;
const WALK_MATCH_MAX_STRAY_M = 40;

function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/**
 * Attach `walkMatchedPath` to every walking segment the matcher can confidently
 * place on the walkable network. One `walkableRoads` query per walk (at the
 * leg's fix centroid, same key as the smoother). Returns a new segment array;
 * the input is not mutated. `WALK_MATCH_DISABLE=1` makes it a no-op (the
 * smoothed/raw baseline, for the score-walk eval).
 */
export async function annotateWalkMatches(
	segments: readonly EnrichedSegment[],
	displayFixes: readonly PedFix[],
	points: readonly FilteredPoint[],
	osm: OsmAdapter,
): Promise<EnrichedSegment[]> {
	if (process.env.WALK_MATCH_DISABLE === "1") return [...segments];

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

		// Centroid + radius over `inWin` — IDENTICAL formula and input set to
		// annotateWalkSmoothing, so the `walkableRoads` adapter key matches the
		// smoother's captured query and the golden corpus needs no re-capture.
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
		if (ways.length === 0) {
			out.push(seg);
			continue;
		}

		// The matcher gets the same fixes with lone teleport spikes dropped.
		const clean = rejectSpikes(inWin);
		if (clean.length < MIN_LEG_FIXES) {
			out.push(seg);
			continue;
		}
		const fixes: RoadFix[] = clean.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
		const result = matchWalkSegment(fixes, { ways });
		if (!result) {
			out.push(seg);
			continue;
		}
		const decision = matchImprovesDisplay(fixes, result.path, { ways }, WALK_NEEDS_MATCH_M, WALK_MATCH_MAX_STRAY_M);
		if (process.env.WALK_MATCH_DEBUG === "1") {
			const t = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);
			console.error(
				`[walk-match] ${t(seg.startTs)}-${t(seg.endTs)} use=${decision.use} rawOff=${decision.rawOffRoadM.toFixed(0)} matchedOff=${decision.matchedOffRoadM.toFixed(0)} stray=${decision.strayM.toFixed(0)} (needs>${WALK_NEEDS_MATCH_M}, stray≤${WALK_MATCH_MAX_STRAY_M})`,
			);
		}
		out.push(decision.use ? { ...seg, walkMatchedPath: result.path } : seg);
	}
	return out;
}
