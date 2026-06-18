/**
 * Rail and drive absorption passes.
 *
 * Folds platform waits into the boarding train, absorbs phantom
 * drive-stops and transit interchanges, and relabels short
 * platform-to-platform walks. Extracted from the velocity orchestrator.
 */

import type { StepPoint } from "../biometrics.js";
import type { EnrichedSegment } from "../enriched-segment.js";
import type { FilteredPoint } from "../kalman.js";
import { type NearbyStation, pickBestStation } from "../osm.js";
import { dbOsmAdapter } from "../osm-adapter.js";
import { effectiveMode, samplesInWindowExclusiveEnd } from "../segment-util.js";
import { parseRailWayName } from "./rail-reconcile.js";
import { RAIL_RUN_STATION_RADIUS_M } from "./rail-runs.js";

/** Longest stationary stretch (s) before a rail run still treated as a
 *  platform / concourse wait and absorbed into boarding the train. A
 *  longer stay at the station is left as its own state. */
const PLATFORM_WAIT_MAX_S = 15 * 60;

/**
 * Absorb a platform wait into the boarding of a rail run.
 *
 * A short stationary segment immediately before a `train` segment whose
 * location resolves to that train's boarding station is the wait on the
 * platform / concourse — part of catching the train, not a separate
 * stay. Left standalone it gets mislabelled: a station is not a focus
 * place, so the place-assigner snaps the stay to the nearest focus
 * place (e.g. a King's Cross platform wait surfaced as "@ Work" 380 m
 * away). Dropping the stationary and extending the train's start back
 * over it makes the timeline read walk → train.
 *
 * The boarding station is read from the train's station-pair wayName
 * (`"<board> → <alight>"`, optionally ` · <line>`), so this works for
 * both annotateRailRuns and annotateUndergroundRuns output.
 */
export async function absorbBoardingPlatform(
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]> = (lat, lon) =>
		dbOsmAdapter.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
): Promise<EnrichedSegment[]> {
	const absorbed = new Set<number>();
	const extendTo = new Map<number, number>();

	for (let k = 1; k < segments.length; k++) {
		const train = segments[k];
		if (train.mode !== "train") continue;
		const arrow = (train.wayName ?? "").indexOf(" → ");
		if (arrow < 0) continue;
		const boardingStation = (train.wayName ?? "").slice(0, arrow);

		const prev = segments[k - 1];
		if (prev.mode !== "stationary") continue;
		if (prev.endTs - prev.startTs > PLATFORM_WAIT_MAX_S) continue;

		const segPoints = samplesInWindowExclusiveEnd(points, prev);
		if (segPoints.length === 0) continue;
		const cLat = segPoints.reduce((a, p) => a + p.lat, 0) / segPoints.length;
		const cLon = segPoints.reduce((a, p) => a + p.lon, 0) / segPoints.length;
		const station = pickBestStation(await stationsLookup(cLat, cLon));
		if (!station || station.name !== boardingStation) continue;

		absorbed.add(k - 1);
		extendTo.set(k, prev.startTs);
	}

	if (absorbed.size === 0) return segments;
	const out: EnrichedSegment[] = [];
	for (let idx = 0; idx < segments.length; idx++) {
		if (absorbed.has(idx)) continue;
		const newStart = extendTo.get(idx);
		out.push(newStart !== undefined ? { ...segments[idx], startTs: newStart } : segments[idx]);
	}
	return out;
}

/** Longest a single stationary segment can be and still count as part
 *  of a transit interchange rather than a genuine stay. A platform-to-
 *  platform change or a wait for the next train runs minutes; a real
 *  stop is longer — and a real stay would also have coalesced with its
 *  neighbours in mergeAdjacentStays. */
const INTERCHANGE_SEGMENT_MAX_S = 8 * 60;

/** Longest a phantom drive-stop can be and still get absorbed. Real
 *  brief drive stops (drop-off, ATM, quick errand) tend to run a few
 *  minutes; longer stops are genuine and shouldn't be absorbed even if
 *  the user happened not to step out of the car. */
const DRIVE_STOP_ABSORB_MAX_S = 15 * 60;

/** Maximum steps accumulated inside a phantom drive-stop. Even briefly
 *  getting out of a car generates a handful of step counts; zero or near-
 *  zero is the biometric tell for "stayed in the vehicle the whole
 *  time". */
const DRIVE_STOP_ABSORB_MAX_STEPS = 5;

/**
 * Absorb a phantom drive-stop into the surrounding drives.
 *
 * A short `stationary` segment sandwiched between two `driving`
 * segments — when the biometric data shows zero / near-zero steps
 * across it — is a GPS-noise-driven phantom stop, not a real one.
 * Classic shape: dense-urban congestion or signal occlusion drops the
 * speed reading to zero, the classifier calls it stationary, and the
 * nearest typed OSM POI (in our motivating case, "The Lanesborough")
 * becomes the place label.
 *
 * If the user actually got out of the car, the watch records steps
 * almost immediately — even three steps from the seat to the kerb
 * appear. Zero steps over a 5–15 minute "stop" is the unambiguous
 * tell that the vehicle never opened its doors.
 *
 * Mirrors `absorbInterchanges` for the road case. Only fires when
 * the sandwich is `driving → short stationary → driving` — a stop at
 * the start or end of a day, or before a longer stay, is left alone.
 */
export function absorbDriveStops(segments: EnrichedSegment[], steps: readonly StepPoint[]): EnrichedSegment[] {
	const stepsBetween = (startTs: number, endTs: number): number => {
		let total = 0;
		for (const p of steps) if (p.ts >= startTs && p.ts <= endTs) total += p.steps;
		return total;
	};
	const onePass = (input: EnrichedSegment[]): { out: EnrichedSegment[]; changed: boolean } => {
		const out: EnrichedSegment[] = [];
		let changed = false;
		let i = 0;
		while (i < input.length) {
			const seg = input[i];
			if (effectiveMode(seg) !== "driving" || i + 2 >= input.length) {
				out.push(seg);
				i++;
				continue;
			}
			const middle = input[i + 1];
			const next = input[i + 2];
			const isPhantomStop =
				effectiveMode(middle) === "stationary" &&
				effectiveMode(next) === "driving" &&
				middle.endTs - middle.startTs <= DRIVE_STOP_ABSORB_MAX_S &&
				stepsBetween(middle.startTs, middle.endTs) <= DRIVE_STOP_ABSORB_MAX_STEPS;
			if (isPhantomStop) {
				out.push({
					...seg,
					endTs: next.endTs,
					pointCount: seg.pointCount + middle.pointCount + next.pointCount,
				});
				i += 3;
				changed = true;
				continue;
			}
			out.push(seg);
			i++;
		}
		return { out, changed };
	};
	let current = segments;
	for (let guard = 0; guard < 10; guard++) {
		const { out, changed } = onePass(current);
		if (!changed) return out;
		current = out;
	}
	return current;
}

/**
 * Absorb a transit interchange into the train it follows.
 *
 * A run of short `stationary` segments immediately after a `train`
 * segment and followed by further movement is not a stay — it is the
 * interchange between trains: a platform-to-platform walk, a wait, or
 * an underground hop the classifier read as stationary because the
 * scattered fixes have little net displacement. Left alone each gets a
 * spurious place label — whatever OSM venue is nearest the noisy
 * underground centroid. This extends the preceding train over the run
 * and drops the run's segments, so the journey reads train → onward
 * with no phantom stop.
 *
 * Only fires for a run *between a train and another moving segment*. A
 * short stationary that ends the day, or that sits before a longer
 * stay, is left as a stay.
 */
export function absorbInterchanges(segments: EnrichedSegment[]): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	let i = 0;
	while (i < segments.length) {
		const seg = segments[i];
		if (effectiveMode(seg) !== "train") {
			out.push(seg);
			i++;
			continue;
		}
		// Collect the run of short stationary segments following the train.
		let runEnd = i + 1;
		while (
			runEnd < segments.length &&
			effectiveMode(segments[runEnd]) === "stationary" &&
			segments[runEnd].endTs - segments[runEnd].startTs <= INTERCHANGE_SEGMENT_MAX_S
		) {
			runEnd++;
		}
		// Absorb only when the run is non-empty AND the journey continues
		// past it with a moving segment — a run that ends the day, or is
		// stopped by a longer stationary stay, is not an interchange.
		const continues = runEnd < segments.length && effectiveMode(segments[runEnd]) !== "stationary";
		if (runEnd > i + 1 && continues) {
			out.push({ ...seg, endTs: segments[runEnd - 1].endTs });
			i = runEnd;
			continue;
		}
		out.push(seg);
		i++;
	}
	return out;
}

/** A walking segment longer than this between two trains is treated as a
 *  genuine out-of-station walk, not a platform interchange. A line change
 *  inside one station is short; walking out to do something and coming back
 *  to the same station is not. */
const INTERCHANGE_WALK_MAX_S = 300;

/**
 * Relabel a short walking segment sandwiched between two train legs that
 * share a station as the interchange at that station.
 *
 * Changing lines (e.g. Metropolitan → Jubilee at Baker Street) is a walk
 * between platforms *inside* the station. GPS often resurfaces mid-change,
 * so the segment is correctly `walking` but gets named after the nearest
 * street the fix happened to see — "Allsop Place" for the 2026-06-16 Baker
 * Street change — which reads as if the user left the station. The two
 * bounding train legs already share a station (leg A alights where leg B
 * boards), so a short walk between them can only be the platform-to-platform
 * interchange. Rewrite its `wayName` to the station; mode and duration are
 * left untouched — the walk is real, only its *location* was wrong.
 */
export function relabelWalkingInterchanges(segments: EnrichedSegment[]): EnrichedSegment[] {
	return segments.map((seg, i) => {
		if (effectiveMode(seg) !== "walking") return seg;
		if (seg.endTs - seg.startTs > INTERCHANGE_WALK_MAX_S) return seg;
		const prev = segments[i - 1];
		const next = segments[i + 1];
		if (!prev || !next || effectiveMode(prev) !== "train" || effectiveMode(next) !== "train") return seg;
		const prevRail = parseRailWayName(prev.wayName);
		const nextRail = parseRailWayName(next.wayName);
		if (!prevRail || !nextRail || prevRail.alight !== nextRail.board) return seg;
		const station = prevRail.alight;
		const lineChange = prevRail.line && nextRail.line ? ` (${prevRail.line} → ${nextRail.line})` : "";
		return {
			...seg,
			wayName: `${station} (interchange)`,
			refinedReason: `walking interchange at ${station}${lineChange}`,
		};
	});
}
