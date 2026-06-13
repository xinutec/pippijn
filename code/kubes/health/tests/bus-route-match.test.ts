import { describe, expect, it } from "vitest";
import { BUS_STOP_ANCHOR_M, type BusRoute, type BusStop, matchBusRoute } from "../src/geo/bus-route-match.js";

/**
 * Stop-anchored bus-route matcher (`src/geo/bus-route-match.ts`). Pins the
 * properties that make it rail-snap-disciplined: a leg matches a route only
 * by anchoring its board + alight to two stops IN ROUTE ORDER, direction
 * is enforced (a reverse ride is a different relation), endpoints that
 * don't reach a stop leave the leg unmatched (taxi), and among competing
 * routes the closest-fitting one wins. Synthetic coords, no DB/OSM.
 */

// London-ish latitude; ~0.004° lon ≈ 280 m, so stops are spaced ~280 m.
const LAT = 51.52;
const LON0 = -0.14;
const STOP_DLON = 0.004;

/** A straight west→east route of `n` stops spaced STOP_DLON apart. */
function linearRoute(routeRef: string, n: number, relId: number, latOffset = 0): BusRoute {
	const stops: BusStop[] = [];
	for (let i = 0; i < n; i++) {
		stops.push({ name: `${routeRef}-stop-${i}`, lat: LAT + latOffset, lon: LON0 + i * STOP_DLON, seq: i });
	}
	return { routeRef, routeName: `Route ${routeRef}`, osmRelationId: relId, stops };
}

/** A coord `meters` east of stop `i` of the given route's geometry. */
function nearStop(route: BusRoute, i: number, metersEast = 0): { lat: number; lon: number } {
	const s = route.stops[i];
	// 1° lon ≈ 69_000 m at this latitude.
	return { lat: s.lat, lon: s.lon + metersEast / 69_000 };
}

describe("matchBusRoute", () => {
	it("returns null when there are no candidate routes", () => {
		const r = linearRoute("38", 6, 1);
		expect(matchBusRoute({ board: nearStop(r, 1), alight: nearStop(r, 4) }, [])).toBeNull();
	});

	it("matches a forward ride: board at an early stop, alight at a later one", () => {
		const r = linearRoute("38", 6, 1);
		const m = matchBusRoute({ board: nearStop(r, 1, 20), alight: nearStop(r, 4, -15) }, [r]);
		expect(m).not.toBeNull();
		expect(m?.routeRef).toBe("38");
		expect(m?.boardStop.seq).toBe(1);
		expect(m?.alightStop.seq).toBe(4);
		expect(m?.stopSpan).toBe(4); // stops 1,2,3,4 inclusive
		expect(m?.boardDistM).toBeLessThan(BUS_STOP_ANCHOR_M);
		expect(m?.alightDistM).toBeLessThan(BUS_STOP_ANCHOR_M);
	});

	it("does NOT match a ride in the wrong route direction (alight before board)", () => {
		// OSM models each direction separately; this single relation runs
		// west→east. A leg boarding at stop 4 and alighting at stop 1 rode
		// the OTHER direction — not this relation.
		const r = linearRoute("38", 6, 1);
		const m = matchBusRoute({ board: nearStop(r, 4), alight: nearStop(r, 1) }, [r]);
		expect(m).toBeNull();
	});

	it("leaves the leg unmatched when an endpoint reaches no stop (taxi pattern)", () => {
		const r = linearRoute("38", 6, 1);
		// Alight 500 m north of the line — no stop within anchor radius.
		const farAlight = { lat: LAT + 500 / 111_000, lon: LON0 + 4 * STOP_DLON };
		const m = matchBusRoute({ board: nearStop(r, 1), alight: farAlight }, [r]);
		expect(m).toBeNull();
	});

	it("does not match when board and alight anchor to the same stop (no travel)", () => {
		const r = linearRoute("38", 6, 1);
		const m = matchBusRoute({ board: nearStop(r, 2, 10), alight: nearStop(r, 2, -10) }, [r]);
		expect(m).toBeNull();
	});

	it("picks the closer-fitting route when two routes both cover the endpoints", () => {
		// Route 38 runs exactly through the endpoints; route 274 is shifted
		// ~50 m north, so its stops are farther from the (on-38) endpoints.
		const r38 = linearRoute("38", 6, 1);
		const r274 = linearRoute("274", 6, 2, 50 / 111_000);
		const board = nearStop(r38, 1);
		const alight = nearStop(r38, 4);
		const m = matchBusRoute({ board, alight }, [r274, r38]);
		expect(m?.routeRef).toBe("38");
	});

	it("on a route that loops past the board coord twice, picks the in-order pair", () => {
		// Stops: 0,1,2 head east, then 3,4 loop back near stop 1's location.
		// Board near the eastbound stop 1; alight near stop 4. Must choose
		// boardIdx=1 (not the later loop stop) so boardIdx < alightIdx holds
		// AND the total anchor distance is minimal.
		const stops: BusStop[] = [
			{ name: "a", lat: LAT, lon: LON0 + 0 * STOP_DLON, seq: 0 },
			{ name: "b", lat: LAT, lon: LON0 + 1 * STOP_DLON, seq: 1 },
			{ name: "c", lat: LAT, lon: LON0 + 2 * STOP_DLON, seq: 2 },
			{ name: "d", lat: LAT, lon: LON0 + 3 * STOP_DLON, seq: 3 },
			{ name: "e", lat: LAT, lon: LON0 + 1 * STOP_DLON, seq: 4 }, // loops back near stop 1
		];
		const route: BusRoute = { routeRef: "C2", routeName: "Loop", osmRelationId: 9, stops };
		const m = matchBusRoute(
			{ board: { lat: LAT, lon: LON0 + 1 * STOP_DLON }, alight: { lat: LAT, lon: LON0 + 2 * STOP_DLON } },
			[route],
		);
		expect(m).not.toBeNull();
		expect(m?.boardStop.seq).toBe(1);
		expect(m?.alightStop.seq).toBe(2);
	});

	it("carries the board/alight stop names through for the timeline label", () => {
		const r = linearRoute("38", 6, 1);
		const m = matchBusRoute({ board: nearStop(r, 0), alight: nearStop(r, 5) }, [r]);
		expect(m?.boardStop.name).toBe("38-stop-0");
		expect(m?.alightStop.name).toBe("38-stop-5");
	});
});
