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
import { fractionOffRoad, matchRoadSegment, type RoadFix } from "./road-match.js";
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

/** Confidence gate. Map-matching only helps when the raw GPS is genuinely off
 *  the road network (the "through the buildings" case). When the raw track
 *  already hugs roads, snapping it can only nudge the line onto a *parallel*
 *  road and make good data worse (observed: a leg with raw fixes ≤8 m from
 *  roads got moved up to 60 m onto the wrong road). So a leg is map-matched
 *  only when at least {@link MIN_OFFROAD_FRACTION} of its fixes are more than
 *  {@link NEEDS_MATCH_M} from any road; otherwise the raw track is drawn. */
const NEEDS_MATCH_M = 25;
const MIN_OFFROAD_FRACTION = 0.3;

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

		// Confidence gate: only map-match when the raw GPS is genuinely off the
		// roads. If it already hugs them, the raw track is the faithful one —
		// matching would risk snapping it onto a parallel road.
		if (fractionOffRoad(fixes, { ways }, NEEDS_MATCH_M) < MIN_OFFROAD_FRACTION) {
			out.push(seg);
			continue;
		}

		const result = matchRoadSegment(fixes, { ways });
		out.push(result ? { ...seg, matchedPath: result.path } : seg);
	}
	return out;
}
