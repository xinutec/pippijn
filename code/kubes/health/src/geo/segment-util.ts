/**
 * Shared helpers for the segment-refinement passes.
 *
 * The classification pipeline is a long cascade of passes (see
 * `computeVelocityFromInputs`), and three small operations recur in almost
 * every one: reading a segment's effective mode, selecting the GPS fixes that
 * fall in a segment's time window, and reducing those to a centroid. Before
 * this module each pass re-implemented them inline — ~24 copies of
 * `refinedMode ?? mode` and ~8 copies of the filter+reduce — which is both
 * noise and a correctness hazard: a copy that forgets the `??` or uses the
 * wrong window boundary is a silent bug. Centralising them removes the
 * duplication and pins ONE documented convention.
 *
 * Pure; no DB, no IO.
 */

import type { TransportMode } from "./segments.js";

/** The minimum shape these helpers read: a time window plus a mode that a
 *  later pass may have refined. */
export interface ModedSegment {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
}

/** Any timestamped sample (a GPS fix, an HR reading, a step row). */
export interface Timestamped {
	ts: number;
}

/**
 * A segment's effective mode: the refined mode a later pass assigned, falling
 * back to the raw classifier mode. This is THE accessor — never read
 * `refinedMode ?? mode` inline; a forgotten `??` silently ignores every
 * refinement the cascade made.
 */
export function effectiveMode(seg: ModedSegment): TransportMode {
	return seg.refinedMode ?? seg.mode;
}

/**
 * The samples whose timestamp falls inside a segment's window.
 *
 * Boundary convention: INCLUSIVE on both ends (`startTs <= ts <= endTs`) — the
 * dominant convention across the pipeline, kept so behaviour is unchanged. A
 * sample landing exactly on a shared boundary is therefore counted by both
 * neighbours; that is harmless for centroids/extents (one sample among many)
 * but NOT for picking the single boarding/alighting fix of a rail leg, where a
 * boundary fix belongs to the neighbour — those sites use
 * {@link samplesInWindowExclusiveEnd} instead. Choose deliberately.
 */
export function samplesInWindow<P extends Timestamped>(
	samples: readonly P[],
	window: { startTs: number; endTs: number },
): P[] {
	return samples.filter((p) => p.ts >= window.startTs && p.ts <= window.endTs);
}

/**
 * Like {@link samplesInWindow} but with an EXCLUSIVE upper bound
 * (`startTs <= ts < endTs`). Use when a sample on the closing boundary belongs
 * to the next segment — e.g. resolving a rail leg's alighting fix, where the
 * boundary fix is the start of the following movement, not the end of the
 * ride (see `stationAtTrainAlight`).
 */
export function samplesInWindowExclusiveEnd<P extends Timestamped>(
	samples: readonly P[],
	window: { startTs: number; endTs: number },
): P[] {
	return samples.filter((p) => p.ts >= window.startTs && p.ts < window.endTs);
}

/** A geographic point. */
export interface LatLon {
	lat: number;
	lon: number;
}

/** The arithmetic-mean centroid of some fixes, or null when there are none.
 *  The unweighted mean of in-window fixes is the pipeline's standard stay
 *  centroid. */
export function centroidOf(fixes: readonly LatLon[]): LatLon | null {
	if (fixes.length === 0) return null;
	let sumLat = 0;
	let sumLon = 0;
	for (const f of fixes) {
		sumLat += f.lat;
		sumLon += f.lon;
	}
	return { lat: sumLat / fixes.length, lon: sumLon / fixes.length };
}
