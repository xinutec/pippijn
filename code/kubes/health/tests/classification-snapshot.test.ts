/**
 * Classification snapshot — the committable CI net for the
 * scored-classification migration (#103).
 *
 * Each test drives a synthetic day through the full `computeVelocityFromInputs`
 * core and pins the per-segment `(mode, wayName)` sequence with an inline
 * snapshot. The snapshots freeze TODAY's behaviour (legacy cascade,
 * `USE_FACTOR_SCORER` unset) so that turning the factor scorer on — the next
 * step of the migration — shows up as an explicit segment-level diff to
 * review, rather than a silent change buried in the rendered timeline.
 *
 * The canonical pair is the migration's whole reason for existing:
 *   - a motorised leg hugging a rail line with no road near  → should be train
 *   - the same speed on a road with no rail near             → should be driving
 * Speed alone cannot separate them; only the map can. These snapshots are the
 * before; the flag flip is the after.
 */

import { describe, expect, it } from "vitest";
import type { Station } from "../src/geo/line-stations.js";
import type { NearbyStation, NearbyWay } from "../src/geo/osm.js";
import { computeVelocityFromInputs } from "../src/geo/velocity.js";
import { segmentSnapshot, synthInputs } from "./helpers/classification-snapshot.js";
import { mockOsmAdapter } from "./helpers/mock-osm-adapter.js";
import { moveBearing, synthDay, tsAt } from "./scenarios/synth-day.js";

const START = tsAt("2026-06-01T09:00:00Z");

async function snapshotOf(...args: Parameters<typeof synthInputs>): Promise<string[]> {
	const { segments } = await computeVelocityFromInputs(synthInputs(...args));
	return segmentSnapshot(segments);
}

describe("classification snapshot (legacy cascade — migration baseline)", () => {
	it("motorised leg hugging a subway line, no road near → train candidate", async () => {
		// 63 km/h for 8 minutes due east, starting at a synthetic anchor.
		const day = synthDay(START, [
			moveBearing({ durationSec: 8 * 60, from: [51.5, -0.1], speedKmh: 63, headingDeg: 90, hr: 88, cadence: 0 }),
		]);
		const subway: NearbyWay = { type: "railway", subtype: "subway", name: "Test Line", distanceM: 14 };
		const board: Station = { name: "Alpha", lat: 51.5, lon: -0.1 };
		const alight: Station = { name: "Omega", lat: 51.5, lon: -0.1 + 0.12 };
		const osm = mockOsmAdapter({
			nearbyWays: () => [subway],
			linesAtPoint: () => new Set(["Test Line"]),
			stationsOnLine: () => [board, alight],
			nearbyStations: (lat, lon): NearbyStation[] => {
				const near = (s: Station) => Math.hypot((lat - s.lat) * 111_000, (lon - s.lon) * 70_000) < 400;
				return [board, alight].filter(near).map((s) => ({ name: s.name, subtype: "subway", distanceM: 50 }));
			},
		});
		expect(await snapshotOf(day, osm)).toMatchInlineSnapshot(`
			[
			  "driving→train · Test Line",
			]
		`);
	});

	it("same speed on a road, no rail near → driving", async () => {
		const day = synthDay(START, [
			moveBearing({ durationSec: 8 * 60, from: [51.5, -0.1], speedKmh: 63, headingDeg: 90, hr: 88, cadence: 0 }),
		]);
		const road: NearbyWay = { type: "highway", subtype: "primary", name: "Test Road", distanceM: 9 };
		const osm = mockOsmAdapter({ nearbyWays: () => [road] });
		expect(await snapshotOf(day, osm)).toMatchInlineSnapshot(`
			[
			  "driving · Test Road",
			]
		`);
	});

	it("motorised leg with both a rail line and a road near, no stations → the genuine ambiguity", async () => {
		// The migration's target case: speed fits driving, a subway hugs the
		// track AND a road runs parallel, and there is no station in range to
		// trigger the rail-run rescue. This is where the legacy cascade and the
		// (off) factor scorer disagree — pin today's answer so the flag flip
		// shows the change.
		const day = synthDay(START, [
			moveBearing({ durationSec: 8 * 60, from: [51.5, -0.1], speedKmh: 63, headingDeg: 90, hr: 88, cadence: 0 }),
		]);
		const subway: NearbyWay = { type: "railway", subtype: "subway", name: "Test Line", distanceM: 16 };
		const road: NearbyWay = { type: "highway", subtype: "primary", name: "Test Road", distanceM: 22 };
		const osm = mockOsmAdapter({ nearbyWays: () => [road, subway] });
		expect(await snapshotOf(day, osm)).toMatchInlineSnapshot(`
			[
			  "driving→train · Test Line",
			]
		`);
	});

	it("walking leg on a footway → walking", async () => {
		const day = synthDay(START, [
			moveBearing({ durationSec: 12 * 60, from: [51.5, -0.1], speedKmh: 5, headingDeg: 90, hr: 102, cadence: 110 }),
		]);
		const footway: NearbyWay = { type: "highway", subtype: "footway", name: "Test Path", distanceM: 4 };
		const osm = mockOsmAdapter({ nearbyWays: () => [footway] });
		expect(await snapshotOf(day, osm)).toMatchInlineSnapshot(`
			[
			  "walking · Test Path",
			]
		`);
	});
});
