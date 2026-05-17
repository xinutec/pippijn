/**
 * Rail-snap: project scattered GPS fixes onto an identified rail track.
 *
 * # Why this exists
 *
 * Underground, a phone falls back to cell-tower positioning. The fixes
 * it emits zigzag wildly — see {@link ./underground-rail.ts}, which
 * already turns such a run into a `train` segment labelled with the
 * line and its boarding/alighting stations. But the *geometry* the map
 * draws is still the raw zigzag.
 *
 * Once we are confident a stretch is a train run on a known line, the
 * track is not a mystery: OSM has its polyline. This module map-matches
 * the fixes onto that polyline so the rendered path follows the rails.
 *
 * # What this is NOT
 *
 * It does not mutate raw fixes. Everything here is pure: given fixes +
 * a route polyline it returns a *derived* snapped path. The raw
 * Owntracks fixes stay the ground truth; the snapped path is recomputed
 * each run from (raw fixes + OSM geometry + the classified segment),
 * the same way `ts_utc` is recomputable. A wrong snap is always
 * reversible by dropping the derived layer.
 *
 * # The three pieces
 *
 *   - {@link projectOntoPolyline} — foot-of-perpendicular of a point
 *     onto a polyline, with distance-along and perpendicular offset.
 *   - {@link stitchWays} — OSM stores a line as many `way` segments;
 *     this joins them (flipping as needed) into connected routes.
 *   - {@link snapFixesToRoute} — map-match a time-ordered fix run onto
 *     a route, forcing monotonic forward progress (a backward-scattered
 *     fix cannot drag the path back) and densifying the output with the
 *     route's own vertices so it hugs the track through curves.
 */

import { queryRouteGeometry } from "./osm-local.js";
import type { EnrichedSegment } from "./velocity.js";

/** A geographic point. */
export interface LatLon {
	lat: number;
	lon: number;
}

/** A raw GPS fix to be snapped — carries a timestamp so the snapped
 *  path can interpolate time along the track. */
export interface SnapFix {
	ts: number;
	lat: number;
	lon: number;
}

/** One vertex of a snapped path: a point on the track with an
 *  interpolated timestamp. */
export interface SnappedPoint {
	ts: number;
	lat: number;
	lon: number;
}

/** The result of projecting a point onto a polyline. */
export interface PolylineProjection {
	/** The foot of the perpendicular — a point *on* the polyline. */
	lat: number;
	lon: number;
	/** Index of the polyline segment the foot lies on (vertex i→i+1). */
	segIndex: number;
	/** Arc length from the polyline's start to the foot, in metres. */
	distAlongM: number;
	/** Perpendicular distance from the input point to the foot, in
	 *  metres — how far the original fix was off the track. */
	offsetM: number;
}

const M_PER_DEG_LAT = 111_000;

/** Straight-line metres between two points (equirectangular — exact
 *  enough at the few-km scale a single rail run spans). */
function metersBetween(a: LatLon, b: LatLon): number {
	const dLat = (b.lat - a.lat) * M_PER_DEG_LAT;
	const dLon = (b.lon - a.lon) * M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/** Local east/north metric frame relative to an origin. Distances
 *  within one rail run are small, so a flat projection is exact
 *  enough and lets us do plain 2-D vector geometry. */
function toXY(p: LatLon, origin: LatLon): { x: number; y: number } {
	const cos = Math.cos((origin.lat * Math.PI) / 180);
	return {
		x: (p.lon - origin.lon) * M_PER_DEG_LAT * cos,
		y: (p.lat - origin.lat) * M_PER_DEG_LAT,
	};
}

function toLatLon(xy: { x: number; y: number }, origin: LatLon): LatLon {
	const cos = Math.cos((origin.lat * Math.PI) / 180);
	return {
		lat: origin.lat + xy.y / M_PER_DEG_LAT,
		lon: origin.lon + xy.x / (M_PER_DEG_LAT * cos),
	};
}

/**
 * Drop `point` perpendicularly onto `polyline`, returning the foot of
 * the perpendicular plus arc-length and offset. The foot is clamped to
 * each segment, so a point beyond an end snaps to the end vertex.
 * Returns null for a degenerate polyline (fewer than two vertices).
 */
export function projectOntoPolyline(point: LatLon, polyline: readonly LatLon[]): PolylineProjection | null {
	if (polyline.length < 2) return null;
	const origin = polyline[0];
	const pts = polyline.map((v) => toXY(v, origin));
	const p = toXY(point, origin);

	let best: { segIndex: number; foot: { x: number; y: number }; along: number; offset: number } | null = null;
	let cumLen = 0;
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const segLen2 = dx * dx + dy * dy;
		// Project p onto the infinite line, clamp the parameter to the
		// segment. A zero-length segment collapses to its start vertex.
		const t = segLen2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / segLen2));
		const foot = { x: a.x + t * dx, y: a.y + t * dy };
		const offset = Math.hypot(p.x - foot.x, p.y - foot.y);
		if (best === null || offset < best.offset) {
			best = { segIndex: i, foot, along: cumLen + t * Math.sqrt(segLen2), offset };
		}
		cumLen += Math.sqrt(segLen2);
	}
	if (best === null) return null;
	const ll = toLatLon(best.foot, origin);
	return { lat: ll.lat, lon: ll.lon, segIndex: best.segIndex, distAlongM: best.along, offsetM: best.offset };
}

/** Total length of a polyline in metres. */
function polylineLength(poly: readonly LatLon[]): number {
	let len = 0;
	for (let i = 1; i < poly.length; i++) len += metersBetween(poly[i - 1], poly[i]);
	return len;
}

/** Try to join two polylines end-to-end, flipping either as needed so
 *  a shared endpoint (within `epsilonM`) becomes an interior vertex.
 *  Returns the joined polyline, or null if they do not touch. */
function tryJoin(a: readonly LatLon[], b: readonly LatLon[], epsilonM: number): LatLon[] | null {
	const aStart = a[0];
	const aEnd = a[a.length - 1];
	const bStart = b[0];
	const bEnd = b[b.length - 1];
	const near = (p: LatLon, q: LatLon): boolean => metersBetween(p, q) <= epsilonM;

	if (near(aEnd, bStart)) return [...a, ...b.slice(1)];
	if (near(aEnd, bEnd)) return [...a, ...[...b].reverse().slice(1)];
	if (near(aStart, bEnd)) return [...b, ...a.slice(1)];
	if (near(aStart, bStart)) return [...[...b].reverse(), ...a.slice(1)];
	return null;
}

/**
 * Join OSM way-segments into connected route polylines.
 *
 * OSM stores a rail line as many `way` features; consecutive ways share
 * an endpoint vertex but may be stored in either direction. This
 * greedily chains ways whose endpoints coincide (within `epsilonM`),
 * flipping orientation where needed. Ways that never connect come back
 * as separate components. The result is sorted longest-first, so the
 * caller can take `[0]` as the main route.
 */
export function stitchWays(ways: readonly (readonly LatLon[])[], epsilonM = 10): LatLon[][] {
	const comps: LatLon[][] = ways.filter((w) => w.length >= 2).map((w) => w.map((p) => ({ ...p })));

	let merged = true;
	while (merged) {
		merged = false;
		for (let i = 0; i < comps.length && !merged; i++) {
			for (let j = i + 1; j < comps.length && !merged; j++) {
				const joined = tryJoin(comps[i], comps[j], epsilonM);
				if (joined) {
					comps[i] = joined;
					comps.splice(j, 1);
					merged = true;
				}
			}
		}
	}

	return comps.sort((a, b) => polylineLength(b) - polylineLength(a));
}

/** Cumulative arc length at each vertex of a route. `cum[0] = 0`. */
function cumulativeLengths(route: readonly LatLon[]): number[] {
	const cum = [0];
	for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + metersBetween(route[i - 1], route[i]));
	return cum;
}

/** The point at arc-length `d` along a route, given precomputed
 *  cumulative lengths. Clamps `d` to the route's extent. */
function pointAtDistance(route: readonly LatLon[], cum: readonly number[], d: number): LatLon {
	const total = cum[cum.length - 1];
	const clamped = Math.max(0, Math.min(total, d));
	for (let i = 1; i < route.length; i++) {
		if (clamped <= cum[i]) {
			const segLen = cum[i] - cum[i - 1];
			const t = segLen === 0 ? 0 : (clamped - cum[i - 1]) / segLen;
			return {
				lat: route[i - 1].lat + t * (route[i].lat - route[i - 1].lat),
				lon: route[i - 1].lon + t * (route[i].lon - route[i - 1].lon),
			};
		}
	}
	return { ...route[route.length - 1] };
}

/**
 * Orient a route to the direction the fixes actually travel.
 *
 * `stitchWays` produces a route with an arbitrary orientation — it may
 * run with or against the journey. The map-match below forces
 * monotonic *forward* progress, so a route pointing the wrong way
 * would collapse every fix onto the start vertex. Compare the mean
 * arc-length of the first half of the fixes against the second half;
 * if progress is net-backwards, reverse the route.
 */
function orientRouteToTravel(sortedFixes: readonly SnapFix[], route: readonly LatLon[]): readonly LatLon[] {
	const along: number[] = [];
	for (const f of sortedFixes) {
		const proj = projectOntoPolyline({ lat: f.lat, lon: f.lon }, route);
		if (proj) along.push(proj.distAlongM);
	}
	if (along.length < 2) return route;
	const mid = Math.floor(along.length / 2);
	const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
	return mean(along.slice(mid)) < mean(along.slice(0, mid)) ? [...route].reverse() : route;
}

/**
 * Map-match a time-ordered run of fixes onto a route polyline.
 *
 * The route is first oriented to the direction of travel. Each fix is
 * then projected onto it to get an arc-length position. Positions are
 * forced monotonically non-decreasing: a fix that projects *behind*
 * its predecessor (GPS scatter on a one-way journey) is clamped
 * forward rather than drawing the path backwards. The output is then
 * densified with the route's own vertices between consecutive fixes,
 * so the snapped path follows the track through curves instead of
 * cutting straight chords. Intermediate vertices get a timestamp
 * linearly interpolated by distance.
 *
 * Returns an empty array for an empty fix list or a degenerate route.
 */
export function snapFixesToRoute(fixes: readonly SnapFix[], rawRoute: readonly LatLon[]): SnappedPoint[] {
	if (fixes.length === 0 || rawRoute.length < 2) return [];

	const sorted = [...fixes].sort((a, b) => a.ts - b.ts);
	const route = orientRouteToTravel(sorted, rawRoute);
	const cum = cumulativeLengths(route);

	// Project each fix; force monotonic forward progress.
	const anchors: Array<{ ts: number; along: number }> = [];
	let maxAlong = 0;
	for (const f of sorted) {
		const proj = projectOntoPolyline({ lat: f.lat, lon: f.lon }, route);
		if (!proj) continue;
		maxAlong = Math.max(maxAlong, proj.distAlongM);
		anchors.push({ ts: f.ts, along: maxAlong });
	}
	if (anchors.length === 0) return [];

	// Emit the first anchor, then for each gap the route vertices that
	// fall strictly inside it (with interpolated ts), then the next
	// anchor. This yields a path that lies entirely on the track.
	const out: SnappedPoint[] = [];
	const emitAnchor = (a: { ts: number; along: number }): void => {
		const p = pointAtDistance(route, cum, a.along);
		out.push({ ts: a.ts, lat: p.lat, lon: p.lon });
	};
	emitAnchor(anchors[0]);
	for (let k = 1; k < anchors.length; k++) {
		const prev = anchors[k - 1];
		const cur = anchors[k];
		const span = cur.along - prev.along;
		if (span > 0) {
			for (let v = 0; v < route.length; v++) {
				if (cum[v] > prev.along && cum[v] < cur.along) {
					const frac = (cum[v] - prev.along) / span;
					out.push({ ts: prev.ts + frac * (cur.ts - prev.ts), lat: route[v].lat, lon: route[v].lon });
				}
			}
		}
		emitAnchor(cur);
	}
	return out;
}

/** A journey-corridor bounding box. */
interface Bbox {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}

/** Fetches the way geometry of one rail line within a corridor bbox.
 *  Injected so the pipeline step is testable without a database. */
export type RouteGeometryLookup = (bbox: Bbox, lineName: string) => Promise<Array<{ coords: LatLon[] }>>;

/** Margin (m) added around the fix bounding box so the fetched line
 *  geometry comfortably brackets the journey on both sides — coarse
 *  fixes can sit a few hundred metres off the actual track. */
const CORRIDOR_MARGIN_M = 600;

/** Axis-aligned bbox enclosing all `fixes`, expanded by `marginM`. */
function corridorBbox(fixes: readonly SnapFix[], marginM: number): Bbox {
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLon = Infinity;
	let maxLon = -Infinity;
	for (const f of fixes) {
		minLat = Math.min(minLat, f.lat);
		maxLat = Math.max(maxLat, f.lat);
		minLon = Math.min(minLon, f.lon);
		maxLon = Math.max(maxLon, f.lon);
	}
	const dLat = marginM / M_PER_DEG_LAT;
	const dLon = marginM / (M_PER_DEG_LAT * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
	return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

/**
 * Attach a derived `snappedPath` to confidently-classified train
 * segments that ran on a known line.
 *
 * For each `train` segment carrying a `railLine` (set by
 * {@link ./underground-rail.ts} only when the line was positively
 * identified — itself the confidence gate), this fetches the line's
 * OSM geometry over the journey corridor, stitches it into a route,
 * and map-matches the segment's raw fixes onto it.
 *
 * The result is purely *additive*: `snappedPath` is a derived render
 * layer, recomputed each run. Raw fixes are never mutated. A segment
 * is left untouched whenever the inference is not safe — no identified
 * line, no OSM geometry for it, too few fixes, or a route that fails
 * to stitch — so the map simply falls back to the raw track.
 */
export async function annotateSnappedPaths(
	segments: readonly EnrichedSegment[],
	rawFixes: readonly SnapFix[],
	geometryLookup: RouteGeometryLookup = (bbox, lineName) => queryRouteGeometry(bbox, lineName),
): Promise<EnrichedSegment[]> {
	const result: EnrichedSegment[] = [];
	for (const seg of segments) {
		if (seg.mode !== "train" || !seg.railLine) {
			result.push(seg);
			continue;
		}
		const fixes = rawFixes.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs);
		if (fixes.length < 2) {
			result.push(seg);
			continue;
		}

		let ways: Array<{ coords: LatLon[] }>;
		try {
			ways = await geometryLookup(corridorBbox(fixes, CORRIDOR_MARGIN_M), seg.railLine);
		} catch {
			result.push(seg);
			continue;
		}

		const route = stitchWays(ways.map((w) => w.coords))[0];
		if (!route || route.length < 2) {
			result.push(seg);
			continue;
		}

		const snapped = snapFixesToRoute(fixes, route);
		if (snapped.length < 2) {
			result.push(seg);
			continue;
		}
		result.push({ ...seg, snappedPath: snapped });
	}
	return result;
}
