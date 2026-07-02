/**
 * Building-escape walk corrector — the explicit, case-based reconstruction of a
 * drawn walk line so it stops running through houses
 * (`docs/proposals/2026-07-continuous-field-walk-reconstruction.md`).
 *
 * The design (Pippijn's), stated as three cases over the drawn line + the OSM
 * walkable network + building footprints:
 *
 *   1. **A vertex lands inside a building** → move it OUT onto the nearest street
 *      *on that building's side*: escape the nearest wall, then snap to the
 *      nearest walkable way just outside it. Never jumps across the block to a
 *      slightly-nearer far-side street.
 *   2. **The segment between two vertices crosses a building** (sparse fixes, so
 *      no vertex sits inside it to push) → route the gap along the walkable
 *      streets between the two anchored endpoints and insert those points, so the
 *      line goes *around* the block instead of through it. (Added in a later
 *      slice; this module currently implements cases 1 and 3.)
 *   3. **No streets nearby** (open ground / forest) → trust the GPS; never move a
 *      vertex when there is no walkable surface to move it onto.
 *
 * Pure and deterministic; geometry in, geometry out, no DB or network.
 */

import { metersBetween, projectPointToSegment, type RoadGeometry } from "./map-match-core.js";
import type { BuildingFootprint } from "./osm-local.js";
import { routeOnWalkable } from "./walkable-route.js";

export interface EscapeOptions {
	/** Step (m) past the escaped wall, so the point clears the footprint before it
	 *  is snapped to a way. */
	wallMarginM: number;
	/** Only snap the escaped point to a street within this radius (m) of the exit;
	 *  beyond it there is no near-side street to land on, so the point is left just
	 *  outside the wall rather than teleported to a distant way. */
	streetSnapRadiusM: number;
}

export const DEFAULT_ESCAPE_OPTIONS: EscapeOptions = {
	wallMarginM: 2,
	streetSnapRadiusM: 20,
};

/** Even-odd ray cast: is `p` inside the closed polygon `ring`? */
function pointInRing(p: { lat: number; lon: number }, ring: BuildingFootprint): boolean {
	if (ring.length < 3) return false;
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const yi = ring[i].lat;
		const xi = ring[i].lon;
		const yj = ring[j].lat;
		const xj = ring[j].lon;
		if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** Nearest point on the closed boundary of `ring` to `p`, with its distance (m).
 *  The ring's closing edge (last→first) is included. */
function nearestOnRing(
	p: { lat: number; lon: number },
	ring: BuildingFootprint,
): { lat: number; lon: number; distM: number } | null {
	let best: { lat: number; lon: number; distM: number } | null = null;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const proj = projectPointToSegment(p, ring[j], ring[i]);
		if (best === null || proj.distM < best.distM) best = { lat: proj.lat, lon: proj.lon, distM: proj.distM };
	}
	return best;
}

/** Nearest point on any walkable way to `p`, with its distance (m); null when the
 *  network is empty. */
function nearestWalkable(
	p: { lat: number; lon: number },
	geo: RoadGeometry,
): { lat: number; lon: number; distM: number } | null {
	let best: { lat: number; lon: number; distM: number } | null = null;
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = { lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] };
			const b = { lat: w.coords[i][0], lon: w.coords[i][1] };
			const proj = projectPointToSegment(p, a, b);
			if (best === null || proj.distM < best.distM) best = { lat: proj.lat, lon: proj.lon, distM: proj.distM };
		}
	}
	return best;
}

/** The building ring `p` is inside, or null. First match wins (footprints rarely
 *  overlap). */
function containingBuilding(
	p: { lat: number; lon: number },
	buildings: readonly BuildingFootprint[],
): BuildingFootprint | null {
	for (const ring of buildings) if (pointInRing(p, ring)) return ring;
	return null;
}

/**
 * Case 1 + case 3, per vertex. If `p` is inside a building, return the escaped
 * position — just past the nearest wall, snapped to the nearest walkable way
 * within `streetSnapRadiusM` (the near-side street). Returns null (leave it) when
 * `p` is not inside a building, or when there is no near-side street to move it
 * onto (case 3 — trust GPS).
 */
function escapedPosition(
	p: { lat: number; lon: number },
	walkable: RoadGeometry,
	buildings: readonly BuildingFootprint[],
	opts: EscapeOptions,
): { lat: number; lon: number } | null {
	const ring = containingBuilding(p, buildings);
	if (!ring) return null;

	const wall = nearestOnRing(p, ring);
	if (!wall || wall.distM < 1e-6) return null; // degenerate; leave it

	// Outward unit direction (from the interior point toward the nearest wall),
	// in a local metric frame, then step `wallMarginM` past the wall.
	const cosLat = Math.cos((p.lat * Math.PI) / 180);
	const dxE = (wall.lon - p.lon) * 111_320 * cosLat;
	const dyN = (wall.lat - p.lat) * 111_320;
	const norm = Math.hypot(dxE, dyN) || 1;
	const outside = {
		lat: wall.lat + ((dyN / norm) * opts.wallMarginM) / 111_320,
		lon: wall.lon + ((dxE / norm) * opts.wallMarginM) / (111_320 * cosLat),
	};

	// Snap to the nearest street on this side (from just outside the wall, so the
	// nearest way is the near-side one), if one is close enough. Case 3: no street
	// near → TRUST GPS, leave the vertex untouched. The street is the only evidence
	// we have for where the true path is; without it we do not move the point (and
	// certainly do not teleport it to a distant way).
	const near = nearestWalkable(outside, walkable);
	if (near && near.distM <= opts.streetSnapRadiusM) return { lat: near.lat, lon: near.lon };
	return null;
}

/**
 * Apply the building-escape correction to a drawn walk line. Generic over the
 * vertex type so every field (`ts`, etc.) is carried through untouched — only
 * `lat`/`lon` are rewritten, and only for a vertex that escapes a building.
 * Returns a new array; the input is not mutated. Currently implements cases 1 and
 * 3 (per-vertex escape + trust-GPS); case 2 (route a chord that crosses a building
 * around the block) lands in a later slice.
 */
export function escapeBuildings<T extends { lat: number; lon: number }>(
	drawn: readonly T[],
	walkable: RoadGeometry,
	buildings: readonly BuildingFootprint[],
	opts: EscapeOptions = DEFAULT_ESCAPE_OPTIONS,
): T[] {
	if (buildings.length === 0) return drawn.map((p) => ({ ...p }));
	return drawn.map((p) => {
		const moved = escapedPosition(p, walkable, buildings, opts);
		return moved ? { ...p, lat: moved.lat, lon: moved.lon } : { ...p };
	});
}

/** One corrected walk vertex. */
export interface CorrectedPoint {
	lat: number;
	lon: number;
	ts: number;
}

export interface CorrectOptions extends EscapeOptions {
	/** Densify chords longer than this (m) before escaping, so a sparse gap has
	 *  vertices the buildings can push (the precondition for case 1 to see a
	 *  crossing at all). */
	densifyStepM: number;
	/** Honesty guard for case 2: refuse a street route longer than this multiple
	 *  of the gap's straight-line distance — a longer "route around" is an
	 *  invented detour, not a plausible walk. */
	maxDetourRatio: number;
	/** Only route when both gap anchors have a walkable way within this (m). */
	routeSnapRadiusM: number;
	/** Ignore residual crossings shorter than this (m) — clipping a mis-mapped
	 *  porch corner is not worth a reroute. */
	minCrossingM: number;
	/** Whole-leg honesty budget: all accepted reroutes together may lengthen the
	 *  drawn leg by at most this fraction of its original length. A single block
	 *  detour fits comfortably; a smeared indoor leg whose every jitter would
	 *  route around shelves exhausts the budget immediately and stays honest raw
	 *  GPS. (This is what the per-gap ratio alone cannot bound: many small gaps,
	 *  each individually plausible, compounding into an invented hike.) */
	maxLegInflation: number;
	/** Budget floor (m): a short leg that IS one block detour still gets to make
	 *  it — the budget exists to stop compounding, not to forbid the single
	 *  honest reroute. The per-gap `maxDetourRatio` still bounds that one route. */
	minRouteBudgetM: number;
}

export const DEFAULT_CORRECT_OPTIONS: CorrectOptions = {
	...DEFAULT_ESCAPE_OPTIONS,
	densifyStepM: 6,
	maxDetourRatio: 2.5,
	routeSnapRadiusM: 35,
	minCrossingM: 3,
	maxLegInflation: 0.5,
	minRouteBudgetM: 150,
};

/** Length (m) of the segment a→b lying inside any building (2 m midpoint
 *  sampling — the geo-side twin of the eval metric, kept local so geo does not
 *  depend on eval). */
function crossedLengthM(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
	buildings: readonly BuildingFootprint[],
): number {
	const segLen = metersBetween(a.lat, a.lon, b.lat, b.lon);
	if (segLen === 0 || buildings.length === 0) return 0;
	const steps = Math.max(1, Math.ceil(segLen / 2));
	let crossed = 0;
	for (let k = 0; k < steps; k++) {
		const f = (k + 0.5) / steps;
		const mid = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
		if (containingBuilding(mid, buildings)) crossed += segLen / steps;
	}
	return crossed;
}

/** Total crossed length (m) over a polyline. */
function pathCrossedM(
	pts: ReadonlyArray<{ lat: number; lon: number }>,
	buildings: readonly BuildingFootprint[],
): number {
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += crossedLengthM(pts[i - 1], pts[i], buildings);
	return total;
}

/** Insert intermediate vertices so no chord exceeds `stepM`; timestamps are
 *  interpolated linearly along each chord. Original vertices are kept exactly. */
function densify(drawn: readonly CorrectedPoint[], stepM: number): CorrectedPoint[] {
	const out: CorrectedPoint[] = [];
	for (let i = 0; i < drawn.length; i++) {
		if (i > 0) {
			const a = drawn[i - 1];
			const b = drawn[i];
			const len = metersBetween(a.lat, a.lon, b.lat, b.lon);
			const extra = Math.floor(len / stepM);
			for (let k = 1; k <= extra; k++) {
				const f = k / (extra + 1);
				out.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, ts: a.ts + (b.ts - a.ts) * f });
			}
		}
		out.push({ ...drawn[i] });
	}
	return out;
}

/**
 * The full case-based corrector for a drawn walk line:
 *
 *   densify → case-1 escape each vertex off a building onto its near-side street
 *   → where a gap STILL crosses a block (no vertex inside it, or no near street
 *   for the escape), case-2 route the gap along the walkable streets around the
 *   block → case-3 everywhere else: trust the GPS.
 *
 * Honesty invariants, all enforced here:
 *   - a reroute happens only when a street route exists, is at most
 *     `maxDetourRatio`× the gap's straight line, AND reduces that gap's
 *     building-crossing — otherwise the original chord is kept;
 *   - the corrected line as a whole must cross LESS building than the input, or
 *     the input is returned unchanged;
 *   - timestamps are preserved on original vertices and interpolated
 *     monotonically on inserted ones.
 *
 * Pure and deterministic. Returns a new array; input untouched.
 */
export function correctWalkPath(
	drawn: readonly CorrectedPoint[],
	walkable: RoadGeometry,
	buildings: readonly BuildingFootprint[],
	opts: CorrectOptions = DEFAULT_CORRECT_OPTIONS,
): CorrectedPoint[] {
	if (drawn.length < 2 || buildings.length === 0) return drawn.map((p) => ({ ...p }));
	// Fast path: nothing crosses → nothing to do (the common clean walk pays one
	// sampling sweep and is returned untouched, un-densified).
	const originalCrossM = pathCrossedM(drawn, buildings);
	if (originalCrossM < opts.minCrossingM) return drawn.map((p) => ({ ...p }));

	// Densify so a crossing run has enough vertices for anchors + the escape
	// fallback, then find each maximal run of building-crossing segments.
	const pts = densify(drawn, opts.densifyStepM);
	const segCross: number[] = [];
	for (let k = 1; k < pts.length; k++) segCross.push(crossedLengthM(pts[k - 1], pts[k], buildings));

	// Whole-leg reroute budget (m): total added length across ALL accepted routes.
	let originalLenM = 0;
	for (let k = 1; k < drawn.length; k++)
		originalLenM += metersBetween(drawn[k - 1].lat, drawn[k - 1].lon, drawn[k].lat, drawn[k].lon);
	let budgetM = Math.max(originalLenM * opts.maxLegInflation, opts.minRouteBudgetM);

	const out: CorrectedPoint[] = [];
	let i = 0;
	while (i < pts.length) {
		// Next crossing run at or after vertex i.
		let runStart = -1;
		for (let s = i; s < segCross.length; s++) {
			if (segCross[s] > 0) {
				runStart = s;
				break;
			}
		}
		if (runStart === -1) {
			for (; i < pts.length; i++) out.push(pts[i]);
			break;
		}
		let runEnd = runStart;
		while (runEnd + 1 < segCross.length && segCross[runEnd + 1] > 0) runEnd++;

		// Anchors: the nearest vertices OUTSIDE any building bracketing the run —
		// routing from inside a footprint would start the street path dishonestly.
		let a = runStart;
		while (a > i && containingBuilding(pts[a], buildings)) a--;
		let b = runEnd + 1;
		while (b < pts.length - 1 && containingBuilding(pts[b], buildings)) b++;

		// Copy the clean prefix up to (and including) the start anchor.
		for (; i <= a; i++) out.push(pts[i]);

		const anchorA = pts[a];
		const anchorB = pts[b];
		let runCrossM = 0;
		for (let s = a; s < b; s++) runCrossM += segCross[s] ?? 0;

		// CASE 2 FIRST — route the whole gap along the streets. Holistic: one run,
		// one route; this is what avoids the zigzag a per-vertex escape produces
		// when mid-block vertices are equidistant from opposite walls.
		let replaced = false;
		if (runCrossM >= opts.minCrossingM) {
			const straightM = metersBetween(anchorA.lat, anchorA.lon, anchorB.lat, anchorB.lon);
			const route = routeOnWalkable(anchorA, anchorB, walkable, {
				snapRadiusM: opts.routeSnapRadiusM,
				maxRouteM: Math.max(50, straightM * opts.maxDetourRatio),
			});
			if (route && route.length >= 2) {
				// Honesty guards: the route must cross meaningfully less than the gap
				// it replaces, AND its added length must fit the whole-leg budget.
				const routeCrossM = pathCrossedM(route, buildings);
				let total = 0;
				const cum: number[] = [0];
				for (let k = 1; k < route.length; k++) {
					total += metersBetween(route[k - 1].lat, route[k - 1].lon, route[k].lat, route[k].lon);
					cum.push(total);
				}
				const addedM = total - straightM;
				if (routeCrossM < runCrossM && addedM <= budgetM) {
					budgetM -= Math.max(0, addedM);
					// Timestamps: interpolate along the route by cumulative distance
					// between the anchors' real times. The route's (street-snapped)
					// start supersedes the copied anchor position; its timestamp is kept.
					out.pop();
					for (let k = 0; k < route.length; k++) {
						const f = total > 0 ? cum[k] / total : 0;
						out.push({ lat: route[k].lat, lon: route[k].lon, ts: anchorA.ts + (anchorB.ts - anchorA.ts) * f });
					}
					replaced = true;
				}
			}
		}
		if (!replaced) {
			// CASE 1 FALLBACK — no honest route around; escape each interior vertex
			// off the building onto its near-side street. Kept only if it reduces the
			// gap's crossing AND its added length fits the same whole-leg budget the
			// routes draw from — an escape can zigzag between opposite walls of a
			// wide block (or across a smeared indoor leg), inflating the path just
			// like compounded reroutes would. Else CASE 3: the original gap stands
			// (trust GPS).
			const gap = pts.slice(a, b + 1);
			const escaped = escapeBuildings(gap, walkable, buildings, opts);
			const lenOf = (xs: readonly CorrectedPoint[]): number => {
				let len = 0;
				for (let k = 1; k < xs.length; k++) len += metersBetween(xs[k - 1].lat, xs[k - 1].lon, xs[k].lat, xs[k].lon);
				return len;
			};
			const addedM = lenOf(escaped) - lenOf(gap);
			let kept = gap;
			if (pathCrossedM(escaped, buildings) < runCrossM && addedM <= budgetM) {
				budgetM -= Math.max(0, addedM);
				kept = escaped;
			}
			for (let k = 1; k <= b - a; k++) out.push(kept[k]);
		}
		// Continue after the end anchor (already in `out`).
		i = b + 1;
	}

	// Whole-line honesty invariant: never return a line that crosses more than
	// the input did.
	if (pathCrossedM(out, buildings) > originalCrossM) return drawn.map((p) => ({ ...p }));
	return out;
}

// re-export for callers that want the metre helper without a second import.
export { metersBetween };
