/**
 * Episode geometry — the map's half of the "one day, two renderers"
 * model. See `docs/design/episode-geometry.md`.
 *
 * The "your day" narrative renders the smoothed `DayState[]` sequence;
 * the map used to render the raw `EnrichedSegment[]` separately, so the
 * two drifted (a sub-state segment the narrative folded away still drew
 * on the map). `buildEpisodes` resolves a display geometry for each
 * `DayState`, 1:1, so both views render the same episode sequence.
 *
 * Pure: no DB, no network, no side effects. Computed inside
 * `computeVelocityFromInputs`, so it is cached with the rest of the
 * velocity result (one `getVelocityCached` entry). Geometry is strictly
 * downstream of classification and never feeds back — depiction never
 * re-decides what happened.
 *
 * The motivating fix is the per-mode SPEED-PLAUSIBILITY FILTER: a raw
 * moving episode drops fixes whose speed exceeds the physical ceiling
 * for its mode (`MAX_SPEED_FOR_MODE`). A 60 km/h fix inside a `walking`
 * episode is a neighbouring fast mode bleeding across an early segment
 * boundary — it is not walking, and the map will not draw it as walking.
 * This is the display analogue of constraint C2.
 */

import type { DayState, DayStateMode } from "../sleep/day-state.js";
import type { FilteredPoint } from "./kalman.js";
import { MAX_SPEED_FOR_MODE } from "./mode-biometrics.js";
import type { EnrichedSegment } from "./velocity.js";

/** Geometry provenance — the only style input the map needs. Solid for
 *  `raw`/`matched`, dashed for `snapped`/`tentative`, a dot for
 *  `anchor`. No `confidence` field: the only upstream confidence is
 *  classification confidence, which is not geometry trust. */
export type EpisodeKind = "snapped" | "raw" | "anchor" | "tentative" | "matched";

/** One episode's display geometry, 1:1 with a `DayState`. Self-describing
 *  (carries its own `startTs`/`endTs`/`mode`) so the map renders it
 *  without re-joining to `states`. `points` may be empty — the map then
 *  draws nothing for that episode (e.g. a synthesized pre-fix sleep). */
export interface EpisodeGeometry {
	startTs: number;
	endTs: number;
	mode: DayStateMode;
	kind: EpisodeKind;
	points: LatLon[];
	/** Stay label for an `anchor` episode (the map's marker popup). Lifted
	 *  from the state's `place` so the frontend draws markers from episodes
	 *  alone and needs no segment lookup. Absent for non-anchor episodes. */
	place?: string;
}

interface LatLon {
	lat: number;
	lon: number;
}

/** A no-GPS `unknown` gap longer than this (metres, straight-line) is
 *  not bridged — drawing a dashed line kilometres across a city would
 *  imply a route we do not have. Display constant, the sibling of
 *  `rejectSpikes`'s 500 m spike bar; not a classifier threshold. */
const UNKNOWN_CONNECTOR_MAX_M = 2000;

/** A raw train leg whose drawn end sits more than this from its station
 *  join point gets that point stitched on, so the leg reaches its station
 *  and the neighbour doesn't bridge across the gap. Below it the gap is
 *  negligible and stitching would add a redundant near-duplicate point. */
const STATION_STITCH_MIN_M = 100;

const MOVING_MODES: ReadonlySet<DayStateMode> = new Set(["walking", "cycling", "driving", "bus", "plane"]);

/**
 * Resolve a display geometry for every `DayState`, in order. Sequence-
 * aware: the `unknown` connector reads the previous resolved episode and
 * the next state's entry point.
 */
export function buildEpisodes(
	states: readonly DayState[],
	segments: readonly EnrichedSegment[],
	points: readonly FilteredPoint[],
): EpisodeGeometry[] {
	const episodes: EpisodeGeometry[] = [];
	for (let i = 0; i < states.length; i++) {
		episodes.push(resolveEpisode(states[i], i, states, segments, points, episodes));
	}
	return episodes;
}

function resolveEpisode(
	state: DayState,
	index: number,
	states: readonly DayState[],
	segments: readonly EnrichedSegment[],
	points: readonly FilteredPoint[],
	resolved: readonly EpisodeGeometry[],
): EpisodeGeometry {
	const mode = state.mode;
	const base = { startTs: state.startTs, endTs: state.endTs, mode };
	const covering = segments.filter((s) => s.startTs < state.endTs && s.endTs > state.startTs);
	const windowFixes = points.filter((p) => p.ts >= state.startTs && p.ts <= state.endTs);

	if (mode === "train") {
		// A cached route carries a snapped rail line: draw it (clipped to
		// the state window). An uncached ride keeps no snappedPath but
		// still has real GPS for the overground stretch — draw that raw.
		// A fully GPS-dark leg has neither and draws nothing.
		const trainSeg = covering.find((s) => effectiveMode(s) === "train" && (s.snappedPath?.length ?? 0) >= 2);
		const snapped = trainSeg?.snappedPath
			?.filter((sp) => sp.ts >= state.startTs && sp.ts <= state.endTs)
			.map((sp) => ({ lat: sp.lat, lon: sp.lon }));
		if (snapped && snapped.length >= 2) return { ...base, kind: "snapped", points: snapped };

		// Boarding / alighting join points: where the previous episode left off
		// and where the next one begins — i.e. this leg's two stations.
		const from = resolved[index - 1]?.points.at(-1);
		const to = entryPoint(states[index + 1], segments, points);

		// A reconstructed underground leg (pointCount 0) has no real GPS for the
		// ride: its window holds only teleporting cell-network garbage. Draw a
		// clean connector station-to-station in train colour, so the tube leg
		// reads as a line between its stations and the onward walk bridges from
		// the alighting end — not a green line across the gap (the 2026-06-16
		// Baker St → Green Park "walked between stations" artifact). No cap (cf.
		// the `unknown` connector): a rail leg legitimately spans km.
		const reconstructed = covering.some((s) => effectiveMode(s) === "train" && s.pointCount === 0);
		if (reconstructed) return { ...base, kind: "tentative", points: from && to ? [from, to] : [] };

		// Uncached overground leg: real GPS, but it commonly starts after the
		// train pulls away and stops before it arrives. Anchor the ends to the
		// station join points so the whole leg stays train-coloured and its
		// neighbours bridge from zero — otherwise the adjacent walk draws a green
		// line across the missing tail (the ~950 m Baker St tail on 2026-06-16).
		const raw = rejectSpikes(windowFixes).map(toLatLon);
		return { ...base, kind: "raw", points: stitchTrainEnds(raw, from, to) };
	}

	if (MOVING_MODES.has(mode)) {
		// Speed-plausibility filter THEN geometric spike rejection. The
		// filter drops a faster neighbour's fixes that bled across the
		// boundary (e.g. a decelerating train's tail landing inside the
		// following walk at vehicle speed); rejectSpikes drops teleports.
		// They are complementary — the bleed is smooth and monotonic, so
		// rejectSpikes alone would miss it.
		const cap = MAX_SPEED_FOR_MODE[mode];
		const plausible = cap === undefined ? windowFixes : windowFixes.filter((p) => p.speed_kmh <= cap);
		return { ...base, kind: "raw", points: rejectSpikes(plausible).map(toLatLon) };
	}

	if (mode === "stationary" || mode === "sleeping") {
		const anchor = stayAnchor(covering, windowFixes);
		return { ...base, kind: "anchor", points: anchor ? [anchor] : [], ...(state.place ? { place: state.place } : {}) };
	}

	if (mode === "unknown") {
		// A no-GPS gap: a tentative connector between the previous drawn
		// point and the next state's entry point, capped so it cannot
		// imply a cross-city route. Either endpoint missing → draw nothing.
		const from = resolved[index - 1]?.points.at(-1);
		const to = entryPoint(states[index + 1], segments, points);
		if (from && to && equirectMeters(from.lat, from.lon, to.lat, to.lon) <= UNKNOWN_CONNECTOR_MAX_M) {
			return { ...base, kind: "tentative", points: [from, to] };
		}
		return { ...base, kind: "tentative", points: [] };
	}

	return { ...base, kind: "raw", points: rejectSpikes(windowFixes).map(toLatLon) };
}

function effectiveMode(seg: EnrichedSegment): string {
	return seg.refinedMode ?? seg.mode;
}

/** Anchor a raw train leg's geometry to its station join points. A train's
 *  GPS commonly starts after it pulls away and stops before it arrives, so
 *  `raw` falls short of the boarding (`from`) and alighting (`to`) ends; the
 *  adjacent walk then bridges green across the gap. Prepend `from` / append
 *  `to` (when present and more than STATION_STITCH_MIN_M from the existing
 *  end) so the whole leg stays train-coloured and neighbours bridge from
 *  zero. The fixes in between are untouched. */
function stitchTrainEnds(raw: readonly LatLon[], from: LatLon | undefined, to: LatLon | undefined): LatLon[] {
	const pts = [...raw];
	const farFromEnd = (p: LatLon, end: LatLon | undefined): boolean =>
		end === undefined || equirectMeters(p.lat, p.lon, end.lat, end.lon) > STATION_STITCH_MIN_M;
	if (from && farFromEnd(from, pts[0])) pts.unshift(from);
	if (to && farFromEnd(to, pts.at(-1))) pts.push(to);
	return pts;
}

/** A stay's single anchor point: the covering stationary segment's
 *  precomputed centroid if present, else the mean of the window fixes,
 *  else none (a synthesized pre-fix sleep has no fix to anchor to). */
function stayAnchor(covering: readonly EnrichedSegment[], windowFixes: readonly FilteredPoint[]): LatLon | undefined {
	const seg = covering.find((s) => s.centroidLat !== undefined && s.centroidLon !== undefined);
	if (seg?.centroidLat !== undefined && seg.centroidLon !== undefined) {
		return { lat: seg.centroidLat, lon: seg.centroidLon };
	}
	return centroidOf(windowFixes);
}

/** A representative entry coordinate for a state — its first window fix,
 *  else its stay centroid. Used as the far end of an `unknown` connector. */
function entryPoint(
	state: DayState | undefined,
	segments: readonly EnrichedSegment[],
	points: readonly FilteredPoint[],
): LatLon | undefined {
	if (!state) return undefined;
	const first = points.find((p) => p.ts >= state.startTs && p.ts <= state.endTs);
	if (first) return { lat: first.lat, lon: first.lon };
	const covering = segments.filter((s) => s.startTs < state.endTs && s.endTs > state.startTs);
	return stayAnchor(covering, []);
}

function centroidOf(fixes: readonly FilteredPoint[]): LatLon | undefined {
	if (fixes.length === 0) return undefined;
	let lat = 0;
	let lon = 0;
	for (const p of fixes) {
		lat += p.lat;
		lon += p.lon;
	}
	return { lat: lat / fixes.length, lon: lon / fixes.length };
}

function toLatLon(p: FilteredPoint): LatLon {
	return { lat: p.lat, lon: p.lon };
}

function equirectMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((aLat * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Drop lone teleport spikes from a moving episode's fixes — display
 * only; the underlying data keeps every fix. A point juts out and back
 * when the detour through it (prev→point→next) is both several times
 * longer than going straight past it AND a large absolute excess. A
 * gentle path curve or a sharp corner stays well under that bar. (Moved
 * here from the frontend `map.component`, which used to do this; the
 * geometry layer now owns it so both renderers cannot diverge.)
 */
export function rejectSpikes(pts: readonly FilteredPoint[]): FilteredPoint[] {
	if (pts.length < 3) return [...pts];
	const keep: FilteredPoint[] = [pts[0]];
	for (let i = 1; i < pts.length - 1; i++) {
		const prev = keep[keep.length - 1];
		const cur = pts[i];
		const next = pts[i + 1];
		const direct = equirectMeters(prev.lat, prev.lon, next.lat, next.lon);
		const through =
			equirectMeters(prev.lat, prev.lon, cur.lat, cur.lon) + equirectMeters(cur.lat, cur.lon, next.lat, next.lon);
		if (through > direct * 3 && through - direct > 500) continue;
		keep.push(cur);
	}
	keep.push(pts[pts.length - 1]);
	return keep;
}
