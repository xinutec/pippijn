/**
 * Scenario: a tube journey labelled as "driving on Trunk Road X"
 * because the rail line runs underneath a road and `refineMode`
 * prefers the road over the rail.
 *
 * Reproduces today's production case (anonymised): the 21-minute
 * tube ride home from a central station to a suburban one was
 * labelled
 *     driving on Euston Underpass [on trunk "Euston Underpass"]
 * despite the speed pattern being unambiguously rail (sustained
 * 30 km/h cruise with bursts to ~98 km/h between station stops).
 *
 * The realistic segment shape (from prod):
 *   - 21 min duration
 *   - avg 27.4 km/h, max 98.9 km/h
 *   - ~12 km of apparent path
 *   - speed profile: 3 stops + cruise + cruise + cruise (3 stations)
 *   - one cruise segment sustained at 98 km/h for ~70 s
 *     (London road speed limit is 30 mph = 48 km/h)
 *
 * The fix likely lives in `refineMode` (osm.ts), where rail wins
 * over road for high-speed-with-station-stops patterns. Test
 * deferred until the OSM-mock scaffolding is built.
 */

import { describe, it } from "vitest";

describe.todo("scenario: tube journey labelled as driving (refineMode picks road over rail)", () => {
	it("labels a 98 km/h London-area segment as train, not driving", () => {
		// Setup needs:
		//   - Synth 21-min segment with the realistic speed profile
		//   - Mock OSM:
		//       nearbyStations(lat,lon) returns Underground stations along the route
		//       linesAtPoint(lat,lon) returns the tube line (Metropolitan, say)
		//       nearbyWays(lat,lon) returns BOTH the road above (trunk "X")
		//                            AND the rail line below
		//   - Run through refineMode (or the full pipeline)
		//   - Assert: result mode is "train", not "driving"
	});
});
