/**
 * Annotate road-vehicle segments with a street-matched geometry (task #261).
 *
 * The map draws a driving / bus / cycling leg as its raw GPS polyline, which
 * scatters off the carriageway and cuts corners through buildings. This pass
 * reads the OSM street network around each road leg (through the
 * `OsmAdapter`, so it records/replays deterministically like the rail and
 * bus passes) and runs the Newson-Krumm matcher (`road-match.ts`) to snap
 * the leg onto the roads. The result is attached as `matchedPath`; the map's
 * `episode-geometry` layer draws it as `kind:"matched"` and falls back to
 * the raw track when it is absent.
 *
 * Purely additive — like `annotateSnappedPaths` (rail) it never rewrites the
 * mode or the raw fixes, only adds display geometry. With no road data
 * available (a fixture predating #261, or a leg the matcher can't confidently
 * place) `matchedPath` stays undefined and nothing changes.
 */

import type { EnrichedSegment } from "./enriched-segment.js";
import { rejectSpikes } from "./episode-geometry.js";
import type { FilteredPoint } from "./kalman.js";
import { MAX_SPEED_FOR_MODE } from "./mode-biometrics.js";
import type { OsmAdapter } from "./osm-adapter.js";
import { matchImprovesDisplay, matchRoadSegment, type RoadFix } from "./road-match.js";
import { effectiveMode, samplesInWindow } from "./segment-util.js";

/** Effective modes drawn as a raw road polyline today — the legs this pass
 *  targets. Matches `episode-geometry`'s `MOVING_MODES` minus rail/air. */
const ROAD_MODES: ReadonlySet<string> = new Set(["driving", "bus", "cycling"]);

/** Below this many in-window fixes a leg is too sparse to map-match — leave
 *  it for the raw renderer. */
const MIN_LEG_FIXES = 4;

/** Slack (m) added to a leg's fix-cloud radius when reading its street
 *  network, so the roads just past the leg's extent are included. */
const ROAD_QUERY_SLACK_M = 150;

/** Confidence gate, judged on the DRAWN LINE not the fix vertices. Map-matching
 *  only helps when the raw drawn track strays off-road — but the stray is in the
 *  CHORDS between fixes, not the fixes themselves: a sparse leg can have every
 *  fix sitting on a road while the straight lines between them cut ~40 m across
 *  the blocks (observed 2026-06-21: both home drives, fix-off-road 8–14 m but
 *  chord-off-road 37–40 m). The old fix-fraction gate scored 0 there and skipped
 *  matching. {@link matchImprovesDisplay} measures the chords instead, and keeps
 *  the original protection — it accepts the match only when it follows roads
 *  better AND stays within {@link MATCH_MAX_STRAY_M} of every fix, so a snap onto
 *  a far parallel road (the failure the old gate guarded against) is rejected. */
const NEEDS_MATCH_M = 25;
const MATCH_MAX_STRAY_M = 40;

function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/**
 * Attach `matchedPath` to every road-vehicle segment whose leg the matcher
 * can confidently place on the street network. One `drivableRoads` query per
 * road leg (at the leg's fix centroid). Returns a new segment array; the
 * input is not mutated.
 */
export async function annotateRoadMatches(
	segments: readonly EnrichedSegment[],
	points: readonly FilteredPoint[],
	osm: OsmAdapter,
): Promise<EnrichedSegment[]> {
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		const mode = effectiveMode(seg);
		if (!ROAD_MODES.has(mode)) {
			out.push(seg);
			continue;
		}

		// Match the same fixes the map would draw: speed-plausible window
		// fixes with lone teleport spikes dropped (mirrors episode-geometry's
		// moving-mode filter), so a fast neighbour's tail can't drag the match.
		const cap = MAX_SPEED_FOR_MODE[mode];
		const windowFixes = samplesInWindow(points, seg);
		const plausible = cap === undefined ? windowFixes : windowFixes.filter((p) => p.speed_kmh <= cap);
		const clean = rejectSpikes(plausible);
		if (clean.length < MIN_LEG_FIXES) {
			out.push(seg);
			continue;
		}

		// Query the street network around the leg's centroid, sized to reach
		// every fix plus slack. Centroid + radius are deterministic functions
		// of the (frozen) fixes, so the adapter key is stable across record /
		// replay. Radius is rounded to keep the key float-stable.
		let sumLat = 0;
		let sumLon = 0;
		for (const f of clean) {
			sumLat += f.lat;
			sumLon += f.lon;
		}
		const cLat = sumLat / clean.length;
		const cLon = sumLon / clean.length;
		let maxDist = 0;
		for (const f of clean) {
			const d = metersBetween(cLat, cLon, f.lat, f.lon);
			if (d > maxDist) maxDist = d;
		}
		const radiusM = Math.round(maxDist + ROAD_QUERY_SLACK_M);

		const ways = await osm.drivableRoads(cLat, cLon, radiusM);
		if (ways.length === 0) {
			out.push(seg);
			continue;
		}

		const fixes: RoadFix[] = clean.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));

		// Match first, then decide on the DRAWN line: use the matched path only
		// when the raw chords stray off-road, the match follows the road better,
		// and it stays faithful to where the GPS was (no parallel-road snap).
		const result = matchRoadSegment(fixes, { ways });
		if (!result) {
			out.push(seg);
			continue;
		}
		const decision = matchImprovesDisplay(fixes, result.path, { ways }, NEEDS_MATCH_M, MATCH_MAX_STRAY_M);
		if (process.env.ROAD_MATCH_DEBUG === "1") {
			const t = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);
			console.error(
				`[road-match] ${t(seg.startTs)}-${t(seg.endTs)} use=${decision.use} rawOff=${decision.rawOffRoadM.toFixed(0)} matchedOff=${decision.matchedOffRoadM.toFixed(0)} stray=${decision.strayM.toFixed(0)} (needs>${NEEDS_MATCH_M}, stray≤${MATCH_MAX_STRAY_M})`,
			);
		}
		out.push(decision.use ? { ...seg, matchedPath: result.path } : seg);
	}
	return out;
}
