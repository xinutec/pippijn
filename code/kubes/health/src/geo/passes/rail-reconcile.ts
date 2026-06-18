/**
 * Rail-leg reconciliation passes.
 *
 * Merges adjacent same-route train segments, enforces the back-to-back
 * shared-station constraint between rail legs, parses station-pair
 * wayNames, and attaches precomputed snapped rail geometry. Extracted
 * from the velocity orchestrator.
 */

import type { EnrichedSegment } from "../enriched-segment.js";
import { interpolateTimes } from "../rail-snap.js";
import { effectiveMode } from "../segment-util.js";
import { MOVING_MERGE_MAX_GAP_S } from "./moving.js";

/** The boarding→alighting station pair at the core of a train wayName
 *  ("Victoria → King's Cross St Pancras"), stripped of any "· Line"
 *  suffix. Null when the segment isn't a station-pair-labelled train. */
function trainStationPair(seg: EnrichedSegment): string | null {
	if (effectiveMode(seg) !== "train") return null;
	const w = seg.wayName;
	if (!w?.includes("→")) return null;
	return w.split(" · ")[0].trim();
}

/**
 * Merge consecutive train segments that resolve to the SAME board→alight
 * station pair into one ride. The rail/underground reconstruction can
 * leave a single tube journey as two adjacent train segments — a
 * late-synced fix re-segmenting it, or a coarse-fix split — and only one
 * half may carry the line name, so the timeline shows two identical-route
 * "train A → B" rows back to back (the 2026-06-12 Victoria→King's Cross
 * case). Coalesce them, keeping the line-named label and any snapped
 * geometry. Two DIFFERENT routes never share a station-pair string, so a
 * genuine interchange (a walk separates the legs anyway) is untouched.
 * Pure.
 */
export function mergeAdjacentSameRouteTrains(segments: EnrichedSegment[]): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		const prev = out[out.length - 1];
		const pair = trainStationPair(seg);
		if (
			prev &&
			pair !== null &&
			trainStationPair(prev) === pair &&
			seg.startTs - prev.endTs <= MOVING_MERGE_MAX_GAP_S
		) {
			const w0 = prev.pointCount;
			const w1 = seg.pointCount;
			const wTot = w0 + w1 || 1;
			prev.endTs = seg.endTs;
			prev.pointCount = w0 + w1;
			prev.avgSpeed = Math.round(((prev.avgSpeed * w0 + seg.avgSpeed * w1) / wTot) * 10) / 10;
			prev.maxSpeed = Math.round(Math.max(prev.maxSpeed, seg.maxSpeed) * 10) / 10;
			prev.linearity = Math.round(((prev.linearity * w0 + seg.linearity * w1) / wTot) * 100) / 100;
			// Keep the more specific label — the half that resolved a line.
			if (!(prev.wayName ?? "").includes(" · ") && (seg.wayName ?? "").includes(" · ")) {
				prev.wayName = seg.wayName;
			}
			if (!prev.snappedPath && seg.snappedPath) prev.snappedPath = seg.snappedPath;
			continue;
		}
		out.push({ ...seg });
	}
	return out;
}

/** Separator between a rail run's two stations in a `wayName`. */
const RAIL_STATION_SEP = " → ";
/** Separator before the optional line-name suffix in a rail `wayName`. */
const RAIL_LINE_SEP = " · ";

/**
 * Parse a rail run's station-pair `wayName` — `"<board> → <alight>"`,
 * optionally followed by `" · <line>"`. Returns null when the string
 * is not a station-pair label (a road name, or absent).
 */
export function parseRailWayName(wayName: string | undefined): { board: string; alight: string; line?: string } | null {
	if (wayName === undefined) return null;
	const arrow = wayName.indexOf(RAIL_STATION_SEP);
	if (arrow < 0) return null;
	const board = wayName.slice(0, arrow);
	const rest = wayName.slice(arrow + RAIL_STATION_SEP.length);
	const dot = rest.indexOf(RAIL_LINE_SEP);
	if (dot < 0) return { board, alight: rest };
	return { board, alight: rest.slice(0, dot), line: rest.slice(dot + RAIL_LINE_SEP.length) };
}

/**
 * Physical constraint: two train legs that are back-to-back — adjacent
 * in the segment sequence with nothing between them — must share a
 * station. You cannot step off a train at one station and instantly be
 * on another train at a different station: there is no time and no
 * walk in between.
 *
 * `annotateRailRuns` and `annotateUndergroundRuns` resolve each leg's
 * boarding/alighting stations independently, so a leg reconstructed
 * from coarse underground fixes can land its boarding on a station the
 * previous leg already passed — a sequence that reads as travelling
 * backward. This pass enforces the constraint: where leg A's alighting
 * and leg B's boarding disagree, leg B is rewritten to board where
 * leg A alighted. Leg A's alighting is the trusted value — it is
 * established first, in time order, and a continuing journey picks up
 * from there.
 *
 * Only the station label is corrected; the split time and line name
 * are left as the upstream passes resolved them.
 */
export function reconcileAdjacentRailLegs(segments: EnrichedSegment[]): EnrichedSegment[] {
	const out = segments.map((s) => ({ ...s }));
	for (let i = 1; i < out.length; i++) {
		const a = out[i - 1];
		const b = out[i];
		if (effectiveMode(a) !== "train" || effectiveMode(b) !== "train") continue;
		const aRail = parseRailWayName(a.wayName);
		const bRail = parseRailWayName(b.wayName);
		if (aRail === null || bRail === null) continue;
		if (aRail.alight === bRail.board) continue;
		// Rewriting B's boarding to A's alighting would collapse leg B to
		// a single station — skip rather than emit a degenerate "X → X".
		if (aRail.alight === bRail.alight) continue;
		b.wayName = `${aRail.alight}${RAIL_STATION_SEP}${bRail.alight}${bRail.line ? `${RAIL_LINE_SEP}${bRail.line}` : ""}`;
	}
	return out;
}

/**
 * Attach a `snappedPath` to every train segment whose route is in the
 * precomputed cache.
 *
 * The snapped rail geometry is expensive to compute (a heavy OSM
 * spatial scan) so it is never computed on the request path. The
 * `refresh-rail-routes` CLI computes it offline and stores it in
 * `rail_route_cache`, keyed by the train run's `<board> → <alight>`
 * label. Here we do one indexed lookup, attach the geometry, and
 * interpolate the segment's time window along it. A train run whose
 * route is not yet cached simply keeps no `snappedPath` and the
 * frontend draws its raw fixes — it becomes snapped once the cron has
 * run. Purely additive: the raw track and day-state timeline are
 * untouched.
 */
export function annotateSnappedPaths(
	segments: EnrichedSegment[],
	railRouteCache: ReadonlyArray<{ routeKey: string; geometryJson: string }>,
): EnrichedSegment[] {
	const keys = new Set(
		segments.filter((s) => effectiveMode(s) === "train" && s.wayName).map((s) => s.wayName as string),
	);
	if (keys.size === 0) return segments;

	const geomByKey = new Map<string, Array<{ lat: number; lon: number }>>();
	for (const r of railRouteCache) {
		if (!keys.has(r.routeKey)) continue;
		try {
			const geom = JSON.parse(r.geometryJson) as Array<{ lat: number; lon: number }>;
			if (Array.isArray(geom) && geom.length >= 2) geomByKey.set(r.routeKey, geom);
		} catch {
			// A malformed cache row is non-fatal — skip it; the run draws raw.
		}
	}
	if (geomByKey.size === 0) return segments;

	return segments.map((seg): EnrichedSegment => {
		if (effectiveMode(seg) !== "train" || !seg.wayName) return seg;
		const geom = geomByKey.get(seg.wayName);
		if (!geom) return seg;
		return { ...seg, snappedPath: interpolateTimes(geom, seg.startTs, seg.endTs) };
	});
}
