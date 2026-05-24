/**
 * HMM state-space enumeration.
 *
 * The hidden state at each minute is a `(mode, place, line)` tuple
 * with structural constraints — not every combination is valid:
 *
 *   - `mode = stationary`: `placeId` is a `focus_places.id` or `null`
 *     (off-network); `lineName` is always `null`.
 *   - `mode = train`: `lineName` is a named rail line or
 *     `"unknown_rail"` (catch-all for rides outside known lines);
 *     `placeId` is `null` (the rail run is in transit).
 *   - `mode ∈ {walking, cycling, driving, plane}`: `placeId` and
 *     `lineName` both `null`.
 *   - `mode = unknown`: `placeId` and `lineName` both `null` —
 *     carryover from the segment-level honest-gaps mode for
 *     unobserved minutes.
 *
 * For an MVP user the reachable subspace is ~20-25 states (top-10
 * focus places + 5-6 named lines + 5 movement modes + the
 * unknown_rail / off-network backbone). Bootstrap discovery
 * (mining the user's actual visited places + travelled lines from
 * heuristic-pipeline labels) happens in the caller; this module
 * just enumerates the cartesian product with constraints.
 *
 * Pure function. No DB, no I/O, no globals.
 */

import type { TransportMode } from "../geo/segments.js";

/** A single HMM state. */
export interface State {
	mode: TransportMode;
	/** `focus_places.id` when `mode === "stationary"` and the user is
	 *  at a known place; `null` for off-network stationary or for any
	 *  moving mode. */
	placeId: number | null;
	/** Named rail line when `mode === "train"`; `"unknown_rail"` for
	 *  the catch-all rail-but-not-in-known-set state; `null` for any
	 *  non-train mode. */
	lineName: string | null;
}

/** Minimal focus-place identity needed for state enumeration. The
 *  HMM doesn't care about coordinates here — those come in via the
 *  emission model, which looks them up by id. */
export interface FocusPlaceRef {
	id: number;
	displayName: string | null;
}

export interface BuildStateSpaceInput {
	focusPlaces: readonly FocusPlaceRef[];
	knownLines: readonly string[];
}

/** Stable string key for a state — used as a Map key or
 *  transition/emission lookup index. Same key in, same string out;
 *  distinct states produce distinct keys. */
export function stateKey(s: State): string {
	if (s.mode === "stationary") return `stationary|${s.placeId ?? "none"}`;
	if (s.mode === "train") return `train|${s.lineName ?? "unknown_rail"}`;
	return s.mode;
}

const MOVEMENT_MODES: readonly TransportMode[] = ["walking", "cycling", "driving", "plane", "unknown"];

export function buildStateSpace(input: BuildStateSpaceInput): State[] {
	const states: State[] = [];
	const seen = new Set<string>();

	function push(s: State): void {
		const key = stateKey(s);
		if (seen.has(key)) return;
		seen.add(key);
		states.push(s);
	}

	// Movement modes (no place, no line).
	for (const mode of MOVEMENT_MODES) {
		push({ mode, placeId: null, lineName: null });
	}

	// Off-network stationary (the user is stationary somewhere not in
	// their focus_places set — an unfamiliar café, a friend's flat).
	push({ mode: "stationary", placeId: null, lineName: null });

	// One stationary state per focus place.
	for (const p of input.focusPlaces) {
		push({ mode: "stationary", placeId: p.id, lineName: null });
	}

	// Train states: one per known line + the unknown_rail catch-all.
	for (const lineName of input.knownLines) {
		push({ mode: "train", placeId: null, lineName });
	}
	push({ mode: "train", placeId: null, lineName: "unknown_rail" });

	return states;
}
