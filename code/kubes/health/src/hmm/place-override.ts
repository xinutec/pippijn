/**
 * Bridge: HSMM `decoded_days` segments → heuristic pipeline
 * `EnrichedSegment[]` place override.
 *
 * The heuristic pipeline is good at segment shape (boundaries,
 * way names, biometric joins) but its place attribution can drift
 * — multiple focus places within the OSM cluster radius, brief
 * stop near a POI being labelled as that POI, etc. The HSMM (as of
 * 2026-05-25, after the entry-prior + visit-frequency + mode-prior
 * fixes) scores 96.4% place attribution against ground truth vs
 * 100% (over a narrow denominator) for the pipeline.
 *
 * This module applies the HSMM's place picks to the pipeline's
 * stationary segments: for each pipeline stationary segment, find
 * the HSMM-dominant focus_place across the segment's minutes and
 * override the segment's display name. The pipeline's other fields
 * (`mode`, `wayName`, biometrics, `city`, etc.) are unchanged.
 *
 * Defensive defaults — the override is conservative:
 *   - Only stationary pipeline segments are considered.
 *   - HSMM must agree the user is stationary AND name a known
 *     focus_place AND that place must have a display name.
 *   - Off-network HSMM (`placeId=null`) leaves the pipeline label
 *     intact.
 *   - HSMM-thinks-the-user-is-walking-but-pipeline-says-stationary
 *     leaves the segment alone (avoid contradicting pipeline on
 *     mode-level disagreements; mode is a separate concern).
 *
 * Pure function. No DB, no IO, no globals.
 */

import type { EnrichedSegment } from "../geo/velocity.js";
import type { HmmSegment } from "./persist.js";

export interface PlaceLookup {
	displayName: string | null;
}

/** Apply HSMM-derived place overrides to pipeline segments.
 *
 *  Input `segments` is not mutated — a new array of (possibly
 *  cloned) segments is returned. A segment is cloned only when its
 *  place attribution is being overridden. */
export function applyHsmmPlaceOverride(
	segments: readonly EnrichedSegment[],
	hmmSegments: readonly HmmSegment[],
	places: ReadonlyMap<number, PlaceLookup>,
): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		out.push(maybeOverride(seg, hmmSegments, places));
	}
	return out;
}

function maybeOverride(
	seg: EnrichedSegment,
	hmmSegments: readonly HmmSegment[],
	places: ReadonlyMap<number, PlaceLookup>,
): EnrichedSegment {
	const effectiveMode = seg.refinedMode ?? seg.mode;
	if (effectiveMode === "stationary") {
		return maybeOverridePlace(seg, hmmSegments, places);
	}
	// Movement segments: if HSMM has a confident train @ knownLine
	// pick across this segment, rewrite to train. Skips train-vs-
	// train cases — pipeline's line attribution is finer-grained
	// than the per-line route-graph evidence today.
	if (effectiveMode !== "train") {
		return maybeOverrideMovementToTrain(seg, hmmSegments);
	}
	return seg;
}

/** Generic clustering-bucket markers assigned by `assignDisplayNames`
 *  in `src/geo/focus-places.ts`. These are NOT venue labels — they
 *  identify a cluster's *kind* (you sleep here sometimes) without
 *  naming the venue. The pipeline's `bestPlace` lookup has already
 *  resolved a real venue name (e.g. "Cleveland Clinic London"); the
 *  HSMM override must not overwrite it with the bucket marker. The
 *  sleep-stay resolver in `src/geo/velocity.ts:1014` treats the same
 *  value the same way. */
const GENERIC_BUCKET_LABELS: ReadonlySet<string> = new Set(["Stay"]);

function maybeOverridePlace(
	seg: EnrichedSegment,
	hmmSegments: readonly HmmSegment[],
	places: ReadonlyMap<number, PlaceLookup>,
): EnrichedSegment {
	const dominantPlaceId = findDominantStationaryPlaceId(seg, hmmSegments);
	if (dominantPlaceId === null) return seg;

	const place = places.get(dominantPlaceId);
	if (!place || place.displayName === null) return seg;

	if (GENERIC_BUCKET_LABELS.has(place.displayName)) return seg;

	if (place.displayName === seg.place) return seg;

	return { ...seg, place: place.displayName };
}

/** Minimum avg segment speed for movement→train override. Below
 *  this the segment is more consistent with walking-pace movement
 *  to/from a tube entrance than with riding the train itself. Tube
 *  averages 20-30 km/h; a brisk walk is 5-6 km/h. 8 km/h splits
 *  cleanly. */
const MOVEMENT_TO_TRAIN_MIN_AVG_KMH = 8;

function maybeOverrideMovementToTrain(seg: EnrichedSegment, hmmSegments: readonly HmmSegment[]): EnrichedSegment {
	if (seg.avgSpeed < MOVEMENT_TO_TRAIN_MIN_AVG_KMH) return seg;
	const dominantLine = findDominantTrainLineName(seg, hmmSegments);
	if (dominantLine === null) return seg;
	// Set both `mode` and `refinedMode` so the override sticks
	// through to the user-facing display (which uses
	// `refinedMode ?? mode`). Clear the `refinedReason` since the
	// pipeline's biometric / cadence reclassification reasoning no
	// longer applies — HSMM's route-graph evidence supersedes it.
	return {
		...seg,
		mode: "train",
		refinedMode: "train",
		refinedReason: `hsmm route evidence — ${dominantLine}`,
		wayName: dominantLine,
	};
}

/** For the time window of `seg`, find the rail line name that the
 *  HSMM attributes the most train-overlap-seconds to. Returns null
 *  when no train-with-knownLine HSMM segment dominates the overlap
 *  (no train, only unknown_rail, etc.). */
function findDominantTrainLineName(seg: EnrichedSegment, hmmSegments: readonly HmmSegment[]): string | null {
	const counts = new Map<string, number>();
	for (const h of hmmSegments) {
		if (h.endTs <= seg.startTs) continue;
		if (h.startTs >= seg.endTs) break;
		if (h.mode !== "train") continue;
		if (h.lineName === null || h.lineName === "unknown_rail") continue;
		const overlapStart = Math.max(seg.startTs, h.startTs);
		const overlapEnd = Math.min(seg.endTs, h.endTs);
		const overlap = overlapEnd - overlapStart;
		if (overlap <= 0) continue;
		counts.set(h.lineName, (counts.get(h.lineName) ?? 0) + overlap);
	}
	let bestLine: string | null = null;
	let bestOverlap = 0;
	for (const [line, n] of counts) {
		if (n > bestOverlap) {
			bestLine = line;
			bestOverlap = n;
		}
	}
	return bestLine;
}

/** For the time window of `seg`, find the focus_place id that the
 *  HSMM attributes the most stationary-overlap-seconds to. Returns
 *  null when no stationary-with-placeId HSMM segment dominates the
 *  overlap (off-network only, non-stationary only, or empty). */
function findDominantStationaryPlaceId(seg: EnrichedSegment, hmmSegments: readonly HmmSegment[]): number | null {
	const counts = new Map<number, number>();
	for (const h of hmmSegments) {
		if (h.endTs <= seg.startTs) continue;
		if (h.startTs >= seg.endTs) break; // assumes hmmSegments are time-sorted (true by construction)
		if (h.mode !== "stationary") continue;
		if (h.placeId === null) continue;
		const overlapStart = Math.max(seg.startTs, h.startTs);
		const overlapEnd = Math.min(seg.endTs, h.endTs);
		const overlap = overlapEnd - overlapStart;
		if (overlap <= 0) continue;
		counts.set(h.placeId, (counts.get(h.placeId) ?? 0) + overlap);
	}
	let bestId: number | null = null;
	let bestOverlap = 0;
	for (const [id, n] of counts) {
		if (n > bestOverlap) {
			bestId = id;
			bestOverlap = n;
		}
	}
	return bestId;
}
