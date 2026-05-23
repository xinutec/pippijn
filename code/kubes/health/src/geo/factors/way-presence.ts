/**
 * way-presence factor.
 *
 * Answers "is there any spatial OSM evidence for this candidate?"
 * — a distinct question from osm-distance's "how close is the
 * way?". Without this factor, the candidate generator's fallback
 * (carrying just `originalMode`, no way info) gets a free pass:
 * osm-distance and mode-coherence both return `null` for it, so
 * its total score is `speed-emission` alone — typically positive,
 * since speed-emission rewards the originalMode. Meanwhile a
 * perfectly-good way-attached candidate pays a negative
 * osm-distance contribution as soon as the way is further than the
 * 10m REFERENCE_DISTANCE_M. The result was that for typical urban
 * walking (a residential road 15-30m from the GPS fixes), the
 * unattached fallback beat the way-attached walking candidate and
 * the rendered timeline lost street names across most walks. See
 * the 2026-05-23 backtest in
 * `docs/proposals/2026-05-scored-classification.md`.
 *
 * The factor returns a fixed positive bonus for any candidate
 * with a defined `wayDistanceM` (the load-bearing field — its
 * presence indicates the candidate is anchored to a specific OSM
 * geometry), and `null` for the fallback. The bonus magnitude is
 * calibrated so:
 *
 *   - a residential walking candidate at 15-30m beats the fallback
 *     (typical urban GPS distance with a clear road match);
 *   - a way-attached candidate beyond ~50m loses to the fallback
 *     (the way is too far to be where the user is — better to fall
 *     back to the un-anchored mode label than mis-attribute);
 *   - in genuinely empty areas (no candidate has way info) the
 *     fallback wins by default — no factor knows where the user is,
 *     and the originalMode label is the honest answer.
 *
 * Derivation of the 1.5-nat magnitude: the binding constraint is
 * walking-on-residential, where mode-coherence is neutral (0) and
 * speed-emission gives both walking candidates +0.5. So the
 * way-attached candidate scores `WP - log(distance/10)` and the
 * fallback scores `0`. For the way to win up to distance D, need
 * `WP > log(D/10)`. At D = 50m, `log(5) ≈ 1.61`; at D = 30m,
 * `log(3) ≈ 1.10`. WP = 1.5 puts the cutover near 45m, comfortably
 * inside typical urban GPS accuracy and outside the "way is genuinely
 * far" regime.
 *
 * Re-calibration is a Phase 1 task (alongside REFERENCE_DISTANCE_M
 * and the other factor weights). 1.5 is a defensible default; the
 * fixture-day calibration will tune it.
 */

import type { Factor } from "./types.js";

const WAY_PRESENCE_BONUS_NATS = 1.5;

export const wayPresence: Factor = (candidate, _ctx) => {
	// Named-only: the rendered timeline shows `on <wayName>` and
	// nothing else, so a candidate without a wayName produces the
	// same user-visible output as the fallback. This factor exists
	// to discriminate *label quality* — an un-labellable candidate
	// gets no bonus. See the file-level docstring for the trace of
	// how this was found (2026-05-23 Barn Rise case).
	if (!candidate.wayName || candidate.wayName.length === 0) return null;
	return {
		name: "way-presence",
		score: WAY_PRESENCE_BONUS_NATS,
		rationale: `attached to "${candidate.wayName}" — labelable spatial evidence`,
	};
};
