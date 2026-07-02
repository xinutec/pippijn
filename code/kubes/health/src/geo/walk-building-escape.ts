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

// re-export for callers that want the metre helper without a second import.
export { metersBetween };
