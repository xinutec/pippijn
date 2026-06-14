/**
 * Stop-anchored bus-route matcher — the algorithmic heart of C-bus
 * (`docs/proposals/2026-06-decoder-owns-mode.md`, Phase 2).
 *
 * Today's `bus-evidence.ts` (#247) tells a bus from a taxi by *where it
 * stops*, but it cannot NAME the route. This module does: given a road-
 * vehicle leg's board + alight coordinates and a set of candidate bus
 * routes (each an ordered list of stops), it finds the route the leg
 * actually rode — boarding at one of the route's stops and alighting at a
 * LATER stop in route order.
 *
 * The load-bearing lesson is rail-snap's, learned three reverts the hard
 * way (`docs/design/rail-snap.md`): in this GPS regime **fix positions are
 * not load-bearing** — a per-fix map-match to the route's ways shipped and
 * broke three times. So a route is matched by its STOP SEQUENCE, not by
 * tracing GPS onto its geometry. The board and alight anchor to stops; the
 * stops' route order gives direction; the mid-trace is, at most, a weak
 * tiebreaker handled elsewhere. A leg whose endpoints don't anchor to two
 * in-order stops of any route is left `driving` (taxi/car) — never forced
 * onto a route it didn't ride.
 *
 * Pure: no DB, no OSM, no network, no globals. The orchestrator loads the
 * candidate routes (from `bus_route_cache`) and the leg endpoints and
 * hands them in.
 */

/** One stop on a bus route, in route order. `seq` is the stop's position
 *  along the route (monotonic; array order matches). */
export interface BusStop {
	name: string | null;
	lat: number;
	lon: number;
	seq: number;
}

/** A candidate bus route: an ordered stop list mirrored from an OSM
 *  `route=bus` relation. `stops` is ordered by `seq` (route direction).
 *  OSM models each direction as its own relation, so a route ridden the
 *  other way is a different `BusRoute` with its own stop order. */
export interface BusRoute {
	routeRef: string;
	routeName: string | null;
	osmRelationId: number;
	stops: readonly BusStop[];
}

/** The two coordinates that anchor a leg to a route: where the vehicle
 *  was boarded and where it was left. The mid-trace is deliberately not
 *  part of the match (see module header). */
export interface VehicleLegEndpoints {
	board: { lat: number; lon: number };
	alight: { lat: number; lon: number };
}

/** A successful match: the named route plus the boarded/alighted stops
 *  and how well the endpoints anchored. */
export interface BusRouteMatch {
	routeRef: string;
	routeName: string | null;
	osmRelationId: number;
	boardStop: BusStop;
	alightStop: BusStop;
	/** Metres from the leg's board coord to `boardStop`. */
	boardDistM: number;
	/** Metres from the leg's alight coord to `alightStop`. */
	alightDistM: number;
	/** Stops travelled, inclusive of both ends (alight index − board index
	 *  + 1). A real ride spans ≥ 2 stops; equal endpoints never match. */
	stopSpan: number;
}

/** A board/alight coord must fall within this of a route stop to anchor
 *  to it. The board/alight coord is the leg's first/last GPS fix — where
 *  GPS reacquired *after* pulling away / *before* the stop, not the kerb
 *  itself — plus the stop's mapped-node-vs-kerb offset and urban GPS
 *  error. Measured on the 2026-06-12 Green Park→Victoria 38 leg, the leg
 *  endpoints sat 85–98 m from the true stops (Hyde Park Corner, Wilton
 *  Street), so 75 m was just too tight. 120 m admits them while still
 *  staying short of a parallel route across a junction. Tunable. */
export const BUS_STOP_ANCHOR_M = 120;

export interface MatchOptions {
	/** Override the stop-anchor radius (metres). */
	anchorM?: number;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface Anchor {
	stop: BusStop;
	/** Position in route order (array index). */
	idx: number;
	distM: number;
}

/** Stops within `anchorM` of `coord`, with their route-order index. */
function anchorsNear(coord: { lat: number; lon: number }, route: BusRoute, anchorM: number): Anchor[] {
	const out: Anchor[] = [];
	route.stops.forEach((stop, idx) => {
		const distM = haversineMeters(coord.lat, coord.lon, stop.lat, stop.lon);
		if (distM <= anchorM) out.push({ stop, idx, distM });
	});
	return out;
}

/**
 * Find the bus route the leg rode. For each candidate route, anchor the
 * board and alight coords to stops within `anchorM`, then take the
 * in-route-order pair (boardIdx < alightIdx) with the smallest combined
 * anchor distance. Across routes, the smallest combined-distance match
 * wins. Returns null when no route's stop sequence admits an in-order
 * board→alight pair — the leg stays driving (taxi/car).
 *
 * Direction is enforced by `alightIdx > boardIdx`: a leg ridden the other
 * way matches the opposite-direction relation (a separate `BusRoute`), not
 * this one. Equal endpoints (anchoring to the same stop) never satisfy the
 * strict inequality, so a non-ride can't masquerade as a zero-span match.
 */
export function matchBusRoute(
	leg: VehicleLegEndpoints,
	routes: readonly BusRoute[],
	opts?: MatchOptions,
): BusRouteMatch | null {
	const anchorM = opts?.anchorM ?? BUS_STOP_ANCHOR_M;
	let best: BusRouteMatch | null = null;
	for (const route of routes) {
		const boardCands = anchorsNear(leg.board, route, anchorM);
		const alightCands = anchorsNear(leg.alight, route, anchorM);
		if (boardCands.length === 0 || alightCands.length === 0) continue;

		let bestPair: { board: Anchor; alight: Anchor; total: number } | null = null;
		for (const board of boardCands) {
			for (const alight of alightCands) {
				if (alight.idx <= board.idx) continue; // direction + non-zero span
				const total = board.distM + alight.distM;
				if (bestPair === null || total < bestPair.total) bestPair = { board, alight, total };
			}
		}
		if (bestPair === null) continue;

		if (best === null || bestPair.total < best.boardDistM + best.alightDistM) {
			best = {
				routeRef: route.routeRef,
				routeName: route.routeName,
				osmRelationId: route.osmRelationId,
				boardStop: bestPair.board.stop,
				alightStop: bestPair.alight.stop,
				boardDistM: bestPair.board.distM,
				alightDistM: bestPair.alight.distM,
				stopSpan: bestPair.alight.idx - bestPair.board.idx + 1,
			};
		}
	}
	return best;
}

/** A timeline-ready label for a matched route, in the same `From → To ·
 *  Ref` shape the ground-truth bus cells use (`ground-truth.ts`). Falls
 *  back to the bare ref when a stop has no name. */
export function busRouteLabel(match: BusRouteMatch): string {
	const from = match.boardStop.name;
	const to = match.alightStop.name;
	return from && to ? `${from} → ${to} · ${match.routeRef}` : match.routeRef;
}

/** The fields `annotateBusRoutes` reads/writes on a pipeline segment — a
 *  structural subset of `EnrichedSegment`, so this module stays free of a
 *  velocity import cycle. */
export interface BusRouteAnnotatable {
	startTs: number;
	endTs: number;
	mode: string;
	refinedMode?: string;
	vehicleKind?: "bus";
	wayName?: string;
}

type TsFix = { ts: number; lat: number; lon: number };

/**
 * Name the bus route each road-vehicle leg rode. For every segment whose
 * effective mode is `driving`, anchor its first + last fix to a cached
 * route's stops (`matchBusRoute`); on a match, mark it `vehicleKind:"bus"`
 * and set `wayName` to the route label. Purely additive — an unmatched leg
 * (taxi/car, or no routes loaded) is returned untouched, so with an empty
 * `routes` set the pass is a no-op. Stronger than the dwell-based
 * `bus-evidence` pass: a leg that matches a route's stop sequence IS that
 * bus even with too few dwells to score, which is the short-ride
 * (06-12 Green Park→clinic) failure that motivated C-bus.
 */
export function annotateBusRoutes<T extends BusRouteAnnotatable>(
	segments: readonly T[],
	points: readonly TsFix[],
	routes: readonly BusRoute[],
	opts?: MatchOptions,
): T[] {
	if (routes.length === 0) return segments.slice();
	const out: T[] = [];
	for (const seg of segments) {
		const effective = seg.refinedMode ?? seg.mode;
		if (effective !== "driving") {
			out.push(seg);
			continue;
		}
		const legFixes = points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
		if (legFixes.length < 2) {
			out.push(seg);
			continue;
		}
		const board = legFixes[0];
		const alight = legFixes[legFixes.length - 1];
		const match = matchBusRoute({ board, alight }, routes, opts);
		if (match === null) {
			out.push(seg);
			continue;
		}
		out.push({ ...seg, vehicleKind: "bus", wayName: busRouteLabel(match) });
	}
	return out;
}
