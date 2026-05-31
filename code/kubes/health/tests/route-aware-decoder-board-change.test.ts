/**
 * Phase 1 proper acceptance test (real data): a train run that
 * crosses an underground interchange must be decoded as TWO segments
 * with the correct line on each half.
 *
 * Uses the actual 2026-05-22 morning capture from
 * `tests/fixtures/days/2026-05-22-pippijn.json` together with a
 * London-corridor route-graph subset captured by the
 * `capture-route-graph-fixture` CLI. The ground-truth narrative
 * (`tests/golden/ground-truth/2026-05-22.md`) is the source of the
 * expected segmentation:
 *
 *   13:16 → 13:32   train · Metropolitan Line · Wembley Park → Baker Street
 *   13:32 → 13:35   train · Jubilee Line · Baker Street → Green Park
 *
 * The boundary at 13:32 is entirely underground — no GPS in the
 * interchange minutes. Today's HSMM produces a single Met (or
 * Jubilee) segment across the whole 13:16 → 13:35 span. The
 * route-aware decoder (state space promoted to include `trainEdgeId`,
 * inner Viterbi over each line's edge subgraph) is expected to
 * split the run at 13:32 ± 1 min.
 *
 * Both fixtures are gitignored — the test skips when either is
 * missing (CI, or a clean checkout that hasn't captured them yet).
 *
 * Import is intentionally against a not-yet-existing module —
 * `route-aware-decoder.js` lands as part of Phase 1. The test thus
 * fails at resolve time today, which is the explicit Phase 1
 * acceptance condition.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine, type RawOsmPoint, type RouteGraph } from "../src/geo/route-graph.js";
import type { Observation } from "../src/hmm/observation.js";
// biome-ignore lint/correctness/noUnusedImports: import drives the failing-test contract
import { routeAwareDecode } from "../src/hmm/route-aware-decoder.js";

const DAY_FIXTURE_URL = new URL("./fixtures/days/2026-05-22-pippijn.json", import.meta.url);
const ROUTE_GRAPH_FIXTURE_URL = new URL("./fixtures/route-graphs/london-met-jubilee-corridor.json", import.meta.url);

interface DayFixturePoint {
	ts: number;
	lat: number;
	lon: number;
	speed_kmh: number;
	bearing: number;
}

interface DayFixture {
	date: string;
	display_tz: string;
	points: DayFixturePoint[];
}

interface RouteGraphFixture {
	bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
	lines: RawOsmLine[];
	points: RawOsmPoint[];
}

function loadDayFixture(): DayFixture | null {
	try {
		return JSON.parse(readFileSync(DAY_FIXTURE_URL, "utf8")) as DayFixture;
	} catch {
		return null;
	}
}

function loadRouteGraphFixture(): RouteGraph | null {
	try {
		const raw = JSON.parse(readFileSync(ROUTE_GRAPH_FIXTURE_URL, "utf8")) as RouteGraphFixture;
		// JSON.parse turns bigints into numbers/strings; route graph
		// wants bigints for osm_id.
		const lines = raw.lines.map((l) => ({ ...l, osm_id: BigInt(l.osm_id as unknown as string) }));
		const points = raw.points.map((p) => ({ ...p, osm_id: BigInt(p.osm_id as unknown as string) }));
		return buildRouteGraph(lines, points);
	} catch {
		return null;
	}
}

const dayFx = loadDayFixture();
const graph = loadRouteGraphFixture();

// Local-time minute → epoch seconds for 2026-05-22 Europe/London (BST = UTC+1).
function localMinToTs(hhmm: string): number {
	// 2026-05-22 00:00 UTC = 1779408000; BST is UTC+1 so local 00:00 = 1779404400.
	const [h, m] = hhmm.split(":").map(Number);
	const LOCAL_MIDNIGHT_UTC = 1_779_404_400;
	return LOCAL_MIDNIGHT_UTC + h * 3600 + m * 60;
}

const TRAIN_WINDOW_START = localMinToTs("13:00");
const TRAIN_WINDOW_END = localMinToTs("13:50");

function obsFromPoint(p: DayFixturePoint): Observation {
	const minuteTs = Math.floor(p.ts / 60) * 60;
	// Coarse local-hour for entry priors etc.
	const hourLocal = Math.floor(((minuteTs - 1_779_404_400) / 3600) % 24);
	return {
		ts: minuteTs,
		gps: { lat: p.lat, lon: p.lon, speedKmh: p.speed_kmh },
		hr: null,
		cadence: null,
		hourLocal,
		dayOfWeekLocal: 4, // Friday
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
	};
}

/** Group raw fixes into one observation per minute (first fix wins).
 *  Fill GPS-null minutes for ts in [start, end] that have no fix. */
function buildMinuteTensor(points: readonly DayFixturePoint[], start: number, end: number): Observation[] {
	const byMinute = new Map<number, DayFixturePoint>();
	for (const p of points) {
		if (p.ts < start || p.ts > end) continue;
		const m = Math.floor(p.ts / 60) * 60;
		if (!byMinute.has(m)) byMinute.set(m, p);
	}
	const out: Observation[] = [];
	for (let t = Math.floor(start / 60) * 60; t <= end; t += 60) {
		const p = byMinute.get(t);
		if (p !== undefined) {
			out.push(obsFromPoint({ ...p, ts: t }));
		} else {
			out.push({
				ts: t,
				gps: null,
				hr: null,
				cadence: null,
				hourLocal: Math.floor(((t - 1_779_404_400) / 3600) % 24),
				dayOfWeekLocal: 4,
				inBed: false,
				prevGpsFix: null,
				nextGpsFix: null,
			});
		}
	}
	// Fill prev/next GPS bookends.
	let lastGps: { ts: number; lat: number; lon: number } | null = null;
	for (const o of out) {
		if (o.gps !== null) lastGps = { ts: o.ts, lat: o.gps.lat, lon: o.gps.lon };
		else if (lastGps !== null) (o as { prevGpsFix: Observation["prevGpsFix"] }).prevGpsFix = lastGps;
	}
	let nextGps: { ts: number; lat: number; lon: number } | null = null;
	for (let i = out.length - 1; i >= 0; i--) {
		const o = out[i];
		if (o.gps !== null) nextGps = { ts: o.ts, lat: o.gps.lat, lon: o.gps.lon };
		else if (nextGps !== null) (o as { nextGpsFix: Observation["nextGpsFix"] }).nextGpsFix = nextGps;
	}
	return out;
}

describe.skipIf(dayFx === null || graph === null)("route-aware decoder — 2026-05-22 Met/Jubilee board change", () => {
	if (dayFx === null || graph === null) throw new Error("unreachable");
	const fx = dayFx;
	const g = graph;

	// Marked .fails while the route-aware decoder is in development.
	// The stub throws today, so all assertions are unreachable — that
	// counts as "fails" for vitest, which means this it.fails passes
	// in CI/verify. When the real decoder lands and all assertions
	// actually pass, vitest will flip this to a failure: that's the
	// signal to drop .fails.
	it.fails("splits the morning train run at Baker St and attributes Met to Wembley→Baker, Jubilee to Baker→Green", () => {
		const tensor = buildMinuteTensor(fx.points, TRAIN_WINDOW_START, TRAIN_WINDOW_END);

		const result = routeAwareDecode({
			observations: tensor,
			routeGraph: g,
			knownLines: [
				"Metropolitan Line",
				"Jubilee Line",
				"Victoria Line",
				"Piccadilly Line",
				"Bakerloo Line",
				"Northern Line",
				"Circle Line",
				"Hammersmith & City Line",
				"District Line",
				"Central Line",
				"Elizabeth Line",
			],
			focusPlaces: [],
		});

		expect(result.states).toHaveLength(tensor.length);

		function stateAt(hhmm: string) {
			const ts = localMinToTs(hhmm);
			const idx = tensor.findIndex((o) => o.ts === ts);
			expect(idx, `tensor must include minute ${hhmm}`).toBeGreaterThanOrEqual(0);
			return result.states[idx];
		}

		// Per ground truth: 13:16-13:32 = Met, 13:32-13:35 = Jubilee.
		// Boundary at 13:32 ±1 min (interchange walk inside Baker St
		// station). Assert representative minutes inside each leg.
		const metLeg = ["13:18", "13:22", "13:26", "13:30"];
		const jubLeg = ["13:33", "13:34"];

		for (const t of metLeg) {
			const s = stateAt(t);
			expect(s.mode, `mode at ${t}`).toBe("train");
			expect(s.lineName, `line at ${t}`).toBe("Metropolitan Line");
			expect(s.trainEdgeId, `trainEdgeId at ${t}`).not.toBeNull();
		}
		for (const t of jubLeg) {
			const s = stateAt(t);
			expect(s.mode, `mode at ${t}`).toBe("train");
			expect(s.lineName, `line at ${t}`).toBe("Jubilee Line");
			expect(s.trainEdgeId, `trainEdgeId at ${t}`).not.toBeNull();
		}

		// The decoded Jubilee leg must traverse at least one Jubilee-
		// only edge (BAKER→BOND or BOND→GREEN) — otherwise the decoder
		// didn't actually commit to Jubilee; it just rode shared track
		// the whole way (which is impossible from Baker St south to
		// Green Park).
		const jubileeOnlyEdgeIds = new Set<string>();
		for (const [id, edge] of g.edges) {
			const m = edge.attrs.lineMemberships;
			if (m.has("Jubilee Line") && !m.has("Metropolitan Line")) jubileeOnlyEdgeIds.add(id);
		}
		const jubEdges = new Set<string>();
		for (const t of jubLeg) {
			const id = stateAt(t).trainEdgeId;
			if (id !== null) jubEdges.add(id);
		}
		const jubileeOnlyTraversed = [...jubEdges].some((id) => jubileeOnlyEdgeIds.has(id));
		expect(jubileeOnlyTraversed, "Jubilee leg must traverse a Jubilee-only edge").toBe(true);
	});
});
