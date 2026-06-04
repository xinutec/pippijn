/**
 * Phase 1 of `docs/proposals/2026-05-constraint-first-decoder.md`:
 * train (board, line, alight) candidate generator.
 *
 * A `train @ L` segment is a valid candidate iff:
 *   - The user's GPS context at the segment's start is within
 *     R_station of a station node N₁ on line L.
 *   - The user's GPS context at the end is within R_station of a
 *     station node N₂ on line L.
 *   - N₁ ≠ N₂ and they are graph-connected on L's per-line edge
 *     subgraph.
 *
 * Anything else is not a candidate. The decoder doesn't score it
 * and doesn't consider it.
 *
 * These tests are the acceptance contract for the generator. The
 * synthetic cases pin the surface; the real-data fixture replay
 * pins that the generator correctly handles the 2026-05-22 Met /
 * Jubilee / Victoria rides.
 */

import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine, type RawOsmPoint } from "../src/geo/route-graph.js";
import type { Observation } from "../src/hmm/observation.js";
import { enumerateTrainCandidates } from "../src/hmm/train-candidate-generator.js";

function makeLine(over: Partial<RawOsmLine>): RawOsmLine {
	return {
		osm_id: 1n,
		osm_type: "way",
		feature_type: "railway",
		subtype: "subway",
		name: null,
		tags_json: null,
		geom: "LINESTRING(0 0, 1 1)",
		...over,
	};
}

function makeStation(osmId: bigint, name: string, p: { lat: number; lon: number }): RawOsmPoint {
	return {
		osm_id: osmId,
		osm_type: "node",
		name,
		tags_json: JSON.stringify({ railway: "station", public_transport: "station" }),
		lat: p.lat,
		lon: p.lon,
	};
}

function wkt(...pts: { lat: number; lon: number }[]): string {
	return `LINESTRING(${pts.map((p) => `${p.lon} ${p.lat}`).join(", ")})`;
}

function obs(over: Partial<Observation>): Observation {
	return {
		ts: 1_700_000_000,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 13,
		dayOfWeekLocal: 4,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

// Synthetic 4-station, 2-line scenario.
//
//      WEMBLEY (Met, Jubilee shared)
//         |
//      FINCHLEY (Met, Jubilee shared)
//         |
//      BAKER (Met, Jubilee shared) — interchange
//         |
//      GREEN_PARK (Jubilee only)
//
// Met continues east from Baker to KX (not used in this fixture).
// Jubilee continues south from Baker to Green Park.
const WEMBLEY = { lat: 51.5635, lon: -0.2796 };
const FINCHLEY = { lat: 51.5474, lon: -0.1809 };
const BAKER = { lat: 51.5226, lon: -0.1571 };
const GREEN_PARK = { lat: 51.5067, lon: -0.1428 };

function buildScenarioGraph() {
	return buildRouteGraph(
		[
			// Wembley → Finchley: shared Met+Jub track.
			makeLine({ osm_id: 1n, name: "Metropolitan and Jubilee Lines", geom: wkt(WEMBLEY, FINCHLEY) }),
			// Finchley → Baker: also shared.
			makeLine({ osm_id: 2n, name: "Metropolitan and Jubilee Lines", geom: wkt(FINCHLEY, BAKER) }),
			// Baker → Green Park: Jubilee only.
			makeLine({ osm_id: 3n, name: "Jubilee Line", geom: wkt(BAKER, GREEN_PARK) }),
		],
		[
			makeStation(101n, "Wembley Park", WEMBLEY),
			makeStation(102n, "Finchley Road", FINCHLEY),
			makeStation(103n, "Baker Street", BAKER),
			makeStation(104n, "Green Park", GREEN_PARK),
		],
	);
}

describe("enumerateTrainCandidates — synthetic", () => {
	it("emits no candidates when no minute looks like a train ride", () => {
		const graph = buildScenarioGraph();
		// All walking-speed observations near Wembley.
		const observations: Observation[] = [];
		for (let i = 0; i < 10; i++) {
			observations.push(obs({ ts: 1_700_000_000 + i * 60, gps: { lat: WEMBLEY.lat, lon: WEMBLEY.lon, speedKmh: 4 } }));
		}
		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});
		expect(result).toEqual([]);
	});

	it("emits the valid (Jubilee, Wembley, Green Park) candidate for a single tube ride", () => {
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		// 0..4 walking near Wembley
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: WEMBLEY.lat, lon: WEMBLEY.lon, speedKmh: 4 } }));
		}
		// 5..14 underground train (GPS null), bracketed by the Wembley fix at t=4
		// and a Green Park fix at t=15.
		const lastWembley = { ts: observations[4].ts, lat: WEMBLEY.lat, lon: WEMBLEY.lon };
		const firstGreen = { ts: t0 + 15 * 60, lat: GREEN_PARK.lat, lon: GREEN_PARK.lon };
		for (let i = 5; i < 15; i++) {
			observations.push(
				obs({
					ts: t0 + i * 60,
					gps: null,
					prevGpsFix: lastWembley,
					nextGpsFix: firstGreen,
				}),
			);
		}
		// 15..19 walking near Green Park
		for (let i = 15; i < 20; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: GREEN_PARK.lat, lon: GREEN_PARK.lon, speedKmh: 5 } }));
		}

		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});

		// Exactly one valid candidate: Jubilee from Wembley to Green Park.
		// Met can't be a candidate — Met has no Green Park station, so the
		// (board=Wembley, alight=Green Park, line=Met) triple fails the
		// "alight is on line" check.
		const validLines = result.map((c) => c.line);
		expect(validLines).toContain("Jubilee Line");
		expect(validLines).not.toContain("Metropolitan Line");

		const jub = result.find((c) => c.line === "Jubilee Line");
		expect(jub?.boardStationName).toBe("Wembley Park");
		expect(jub?.alightStationName).toBe("Green Park");
	});

	it("rejects (board, line, alight) where board and alight are the SAME station", () => {
		// Degenerate: the user 'rides' one stop but the GPS context is
		// the same station at both ends. Not a candidate.
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: BAKER.lat, lon: BAKER.lon, speedKmh: 4 } }));
		}
		const lastBaker = { ts: observations[4].ts, lat: BAKER.lat, lon: BAKER.lon };
		const firstBakerAgain = { ts: t0 + 15 * 60, lat: BAKER.lat, lon: BAKER.lon };
		for (let i = 5; i < 15; i++) {
			observations.push(
				obs({
					ts: t0 + i * 60,
					gps: null,
					prevGpsFix: lastBaker,
					nextGpsFix: firstBakerAgain,
				}),
			);
		}
		for (let i = 15; i < 20; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: BAKER.lat, lon: BAKER.lon, speedKmh: 4 } }));
		}
		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});
		expect(result).toEqual([]);
	});

	it("does not emit a candidate when the alight station isn't on the line (Met → Green Park is invalid)", () => {
		// Extend the scenario so a Met-only edge exists east of Baker
		// (e.g. Marylebone). The user's GPS implies Wembley → Green Park,
		// but Met doesn't reach Green Park. Met must NOT be a candidate.
		const MARYLEBONE = { lat: 51.5226, lon: -0.1635 };
		const graph = buildRouteGraph(
			[
				makeLine({ osm_id: 1n, name: "Metropolitan and Jubilee Lines", geom: wkt(WEMBLEY, FINCHLEY) }),
				makeLine({ osm_id: 2n, name: "Metropolitan and Jubilee Lines", geom: wkt(FINCHLEY, BAKER) }),
				makeLine({ osm_id: 3n, name: "Jubilee Line", geom: wkt(BAKER, GREEN_PARK) }),
				// Met-only branch east of Baker.
				makeLine({ osm_id: 4n, name: "Metropolitan Line", geom: wkt(BAKER, MARYLEBONE) }),
			],
			[
				makeStation(101n, "Wembley Park", WEMBLEY),
				makeStation(102n, "Finchley Road", FINCHLEY),
				makeStation(103n, "Baker Street", BAKER),
				makeStation(104n, "Green Park", GREEN_PARK),
				makeStation(105n, "Marylebone", MARYLEBONE),
			],
		);
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: WEMBLEY.lat, lon: WEMBLEY.lon, speedKmh: 4 } }));
		}
		const lastWembley = { ts: observations[4].ts, lat: WEMBLEY.lat, lon: WEMBLEY.lon };
		const firstGreen = { ts: t0 + 15 * 60, lat: GREEN_PARK.lat, lon: GREEN_PARK.lon };
		for (let i = 5; i < 15; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null, prevGpsFix: lastWembley, nextGpsFix: firstGreen }));
		}
		for (let i = 15; i < 20; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: GREEN_PARK.lat, lon: GREEN_PARK.lon, speedKmh: 5 } }));
		}
		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});
		const lines = new Set(result.map((c) => c.line));
		expect(lines).toContain("Jubilee Line");
		expect(lines).not.toContain("Metropolitan Line");
	});

	it("emits two candidates for an interchange ride (Met Wembley→Baker, then Jubilee Baker→Green) — two segments", () => {
		// Same graph as above. The observation window has a dwell at
		// Baker St in the middle (~3 minutes at low speed), splitting
		// the long underground gap into two train-mode windows. The
		// generator should emit a (Met, Wembley, Baker) candidate for
		// the first window and a (Jubilee, Baker, Green Park) candidate
		// for the second.
		const MARYLEBONE = { lat: 51.5226, lon: -0.1635 };
		const graph = buildRouteGraph(
			[
				makeLine({ osm_id: 1n, name: "Metropolitan and Jubilee Lines", geom: wkt(WEMBLEY, FINCHLEY) }),
				makeLine({ osm_id: 2n, name: "Metropolitan and Jubilee Lines", geom: wkt(FINCHLEY, BAKER) }),
				makeLine({ osm_id: 3n, name: "Jubilee Line", geom: wkt(BAKER, GREEN_PARK) }),
				makeLine({ osm_id: 4n, name: "Metropolitan Line", geom: wkt(BAKER, MARYLEBONE) }),
			],
			[
				makeStation(101n, "Wembley Park", WEMBLEY),
				makeStation(102n, "Finchley Road", FINCHLEY),
				makeStation(103n, "Baker Street", BAKER),
				makeStation(104n, "Green Park", GREEN_PARK),
				makeStation(105n, "Marylebone", MARYLEBONE),
			],
		);
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: WEMBLEY.lat, lon: WEMBLEY.lon, speedKmh: 4 } }));
		}
		// Tube Wembley → Baker (5..10)
		const lastWembley = { ts: observations[4].ts, lat: WEMBLEY.lat, lon: WEMBLEY.lon };
		const bakerFix = { ts: t0 + 11 * 60, lat: BAKER.lat, lon: BAKER.lon };
		for (let i = 5; i < 11; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null, prevGpsFix: lastWembley, nextGpsFix: bakerFix }));
		}
		// Dwell at Baker (11..13) — 3 minutes at low speed, observed GPS.
		for (let i = 11; i < 14; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: BAKER.lat, lon: BAKER.lon, speedKmh: 2 } }));
		}
		// Tube Baker → Green (14..18)
		const lastBaker = { ts: observations[13].ts, lat: BAKER.lat, lon: BAKER.lon };
		const greenFix = { ts: t0 + 19 * 60, lat: GREEN_PARK.lat, lon: GREEN_PARK.lon };
		for (let i = 14; i < 19; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null, prevGpsFix: lastBaker, nextGpsFix: greenFix }));
		}
		for (let i = 19; i < 24; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: GREEN_PARK.lat, lon: GREEN_PARK.lon, speedKmh: 5 } }));
		}

		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});

		if (process.env.GEN_DUMP === "1") {
			console.error("GRAPH NODES:");
			for (const n of graph.nodes.values()) {
				console.error(`  ${n.id}  name=${n.stationName ?? "-"}`);
			}
			console.error("CANDIDATES:");
			for (const c of result) {
				console.error(
					`  [${c.startMin}-${c.endMin}] ${c.line}  ${c.boardStationName ?? "?"} → ${c.alightStationName ?? "?"}`,
				);
			}
		}

		// First window: Wembley → Baker. Both Met and Jubilee are valid
		// here (shared track + Baker is on both lines). Two candidates.
		// Second window: Baker → Green. Only Jubilee is valid. One
		// candidate.
		const firstWindow = result.filter((c) => c.boardStationName === "Wembley Park");
		const secondWindow = result.filter((c) => c.boardStationName === "Baker Street");

		expect(firstWindow.length).toBeGreaterThanOrEqual(2);
		const firstLines = new Set(firstWindow.map((c) => c.line));
		expect(firstLines).toContain("Metropolitan Line");
		expect(firstLines).toContain("Jubilee Line");

		expect(secondWindow.length).toBe(1);
		expect(secondWindow[0].line).toBe("Jubilee Line");
		expect(secondWindow[0].alightStationName).toBe("Green Park");
	});
});
