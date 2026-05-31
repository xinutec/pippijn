/**
 * Route-aware decoder — Phase 1 stub.
 *
 * The implementation is in progress. This stub exists so the
 * acceptance test
 * (`tests/route-aware-decoder-board-change.test.ts`) can import and
 * fail-fast on a clear "not implemented" rather than at module
 * resolution.
 *
 * See `docs/proposals/2026-05-route-aware-decoder.md` (Phase 1
 * implementation section) for the design.
 *
 * Replace this stub with the real outer-inner hierarchical Viterbi
 * before declaring Phase 1 done.
 */

import type { RouteGraph } from "../geo/route-graph.js";
import type { Observation } from "./observation.js";
import type { FocusPlaceRef, State } from "./state-space.js";

export interface RouteAwareDecodeInput {
	observations: readonly Observation[];
	routeGraph: RouteGraph;
	knownLines: readonly string[];
	focusPlaces: readonly FocusPlaceRef[];
}

export interface RouteAwareDecodeResult {
	states: readonly State[];
}

export function routeAwareDecode(_input: RouteAwareDecodeInput): RouteAwareDecodeResult {
	throw new Error("routeAwareDecode: not implemented yet (Phase 1 in progress)");
}
