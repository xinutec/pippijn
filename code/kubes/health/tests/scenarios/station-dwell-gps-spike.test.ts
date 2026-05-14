/**
 * Scenario: a brief platform dwell at an interchange station where one
 * GPS fix bounces off (multipath, brief signal loss). The rail-run
 * absorption logic should swallow the dwell as part of the merged train
 * journey, but the current "all fixes within 100 m of centroid" rule is
 * fooled by the single outlier — the dwell surfaces as a separate
 * (typically driving-labelled) segment between two train legs.
 *
 * Reproduces the April 29 production case at Arnhem:
 *   18:09-19:30 train (Den Haag -> Arnhem)
 *   19:32-19:37 driving avg:4.7km/h max:87.8km/h [on footway; low cadence]
 *   19:38-19:47 train (Arnhem -> Nijmegen)
 *
 * The middle "driving" segment is the user walking ~30 m across the
 * platform to a different train. The 87.8 km/h max is one GPS spike
 * that displaced a single fix off the platform.
 */

import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import type { NearbyStation } from "../../src/geo/osm.js";
import { annotateRailRuns, type EnrichedSegment } from "../../src/geo/velocity.js";
import { tsAt } from "./synth-day.js";

const arnhem: [number, number] = [51.985, 5.901];

/** Build a sequence of GPS fixes clustered around a point, with optional
 *  outliers injected at the specified relative offset. */
function platformFixes(
	startTs: number,
	durationSec: number,
	center: [number, number],
	outliers: Array<{ atSec: number; offsetMeters: number }> = [],
): FilteredPoint[] {
	const points: FilteredPoint[] = [];
	const intervalSec = 10;
	const latDegPerMeter = 1 / 111000;
	const lonDegPerMeter = 1 / (111000 * Math.cos((center[0] * Math.PI) / 180));
	for (let dt = 0; dt < durationSec; dt += intervalSec) {
		// Small ±5 m jitter on each fix, deterministic for reproducibility.
		const jitterLat = ((dt * 31) % 11) - 5;
		const jitterLon = ((dt * 17) % 11) - 5;
		points.push({
			ts: startTs + dt,
			lat: center[0] + jitterLat * latDegPerMeter,
			lon: center[1] + jitterLon * lonDegPerMeter,
			speed_kmh: 0,
			bearing: 0,
		});
	}
	for (const o of outliers) {
		// Inject a fix that's `offsetMeters` north of centre — overwrites
		// any nearby fix from the regular schedule.
		const ts = startTs + o.atSec;
		const idx = points.findIndex((p) => p.ts === ts);
		const spike: FilteredPoint = {
			ts,
			lat: center[0] + o.offsetMeters * latDegPerMeter,
			lon: center[1],
			speed_kmh: 87.8,
			bearing: 0,
		};
		if (idx >= 0) points[idx] = spike;
		else points.push(spike);
	}
	return points.sort((a, b) => a.ts - b.ts);
}

const stationLookup = async (_lat: number, _lon: number): Promise<NearbyStation[]> => [
	{ name: "Arnhem Centraal", subtype: "rail", distanceM: 50 },
];
const lineLookup = async (): Promise<Set<string>> => new Set<string>();

describe("scenario: station dwell with a single GPS-spike outlier", () => {
	const trainBefore: EnrichedSegment = {
		startTs: tsAt("2026-04-29T16:09:00Z"),
		endTs: tsAt("2026-04-29T17:30:00Z"),
		mode: "train",
		confidence: 0.98,
		confidenceMargin: 50,
		avgSpeed: 100,
		maxSpeed: 140,
		linearity: 0.88,
		pointCount: 500,
	};
	const dwellStart = tsAt("2026-04-29T17:32:00Z");
	const dwellEnd = tsAt("2026-04-29T17:37:00Z");
	const dwell: EnrichedSegment = {
		startTs: dwellStart,
		endTs: dwellEnd,
		mode: "driving", // post-correction label, matches the prod output
		refinedMode: "driving",
		refinedReason: "low cadence (1/min)",
		confidence: 0.84,
		confidenceMargin: 5.3,
		avgSpeed: 4.7,
		maxSpeed: 87.8,
		linearity: 0.93,
		pointCount: 30,
	};
	const trainAfter: EnrichedSegment = {
		startTs: tsAt("2026-04-29T17:38:00Z"),
		endTs: tsAt("2026-04-29T17:47:00Z"),
		mode: "train",
		confidence: 0.89,
		confidenceMargin: 50,
		avgSpeed: 107,
		maxSpeed: 142,
		linearity: 0.95,
		pointCount: 80,
	};

	// Dwell points: ~30 fixes clustered within ±5 m of platform centre,
	// plus ONE outlier 200 m north — the GPS spike.
	const dwellPoints = platformFixes(dwellStart, dwellEnd - dwellStart, arnhem, [{ atSec: 150, offsetMeters: 200 }]);
	// Train points: just need to exist at the right timestamps for any
	// pipeline code that scans them. Use centre coords; ts coverage is what
	// matters for the absorption decision (which only looks at dwellPoints).
	const trainBeforePoints = platformFixes(trainBefore.startTs, trainBefore.endTs - trainBefore.startTs, arnhem);
	const trainAfterPoints = platformFixes(trainAfter.startTs, trainAfter.endTs - trainAfter.startTs, arnhem);
	const allPoints = [...trainBeforePoints, ...dwellPoints, ...trainAfterPoints];

	it("absorbs the dwell despite one GPS-spike outlier and merges into one train segment", async () => {
		const result = await annotateRailRuns([trainBefore, dwell, trainAfter], allPoints, stationLookup, lineLookup);

		// The whole journey should collapse to one merged-rail-run segment.
		expect(
			result,
			`expected 1 merged segment, got ${result.length}: ${JSON.stringify(result.map((s) => s.mode))}`,
		).toHaveLength(1);
		expect(result[0].mode).toBe("train");
		expect(result[0].refinedReason).toMatch(/merged rail run/);
		expect(result[0].startTs).toBe(trainBefore.startTs);
		expect(result[0].endTs).toBe(trainAfter.endTs);
	});

	it("absorbs a 5-min platform interchange walk (sustained ~400 m path)", async () => {
		// The actual Arnhem case isn't a tight cluster + outlier — it's a
		// sustained ~400 m path at walking pace (4.7 km/h × 5 min). The
		// fixes spread linearly, so a percentile-of-distance-from-centroid
		// check still fails them. ≤5-min bookended by rail-like is the
		// load-bearing signal of a platform interchange.
		const walkingFixes: FilteredPoint[] = [];
		const latDegPerMeter = 1 / 111000;
		const segDur = dwellEnd - dwellStart;
		const totalMeters = 400; // realistic platform-to-platform interchange path
		for (let dt = 0; dt < segDur; dt += 10) {
			const progress = dt / segDur;
			walkingFixes.push({
				ts: dwellStart + dt,
				lat: arnhem[0] + progress * totalMeters * latDegPerMeter,
				lon: arnhem[1],
				speed_kmh: 4.7,
				bearing: 0,
			});
		}
		const result = await annotateRailRuns(
			[trainBefore, dwell, trainAfter],
			[...trainBeforePoints, ...walkingFixes, ...trainAfterPoints],
			stationLookup,
			lineLookup,
		);

		expect(result, `expected 1 merged segment, got ${result.length}`).toHaveLength(1);
		expect(result[0].mode).toBe("train");
	});

	it("does NOT absorb a long off-route segment between trains (e.g. went home, came back)", async () => {
		// Negative control: a much longer duration between trains is a
		// real activity (coffee, meeting, going home). The ≤5-min cap
		// blocks absorption.
		const longDwell: EnrichedSegment = { ...dwell, endTs: dwellStart + 30 * 60 }; // 30 min
		const longFixes = platformFixes(dwellStart, 30 * 60, arnhem);
		const result = await annotateRailRuns(
			[trainBefore, longDwell, trainAfter],
			[...trainBeforePoints, ...longFixes, ...trainAfterPoints],
			stationLookup,
			lineLookup,
		);
		expect(result.length).toBeGreaterThanOrEqual(2);
	});
});
