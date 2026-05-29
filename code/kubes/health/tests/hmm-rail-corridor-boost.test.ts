import { describe, expect, it } from "vitest";
import type { Observation } from "../src/hmm/observation.js";
import { buildRailCorridorBoost } from "../src/hmm/rail-corridor-boost.js";
import type { State } from "../src/hmm/state-space.js";

/**
 * `buildRailCorridorBoost` is a per-minute emission boost for
 * `train @ L` states when the surrounding observed GPS fixes are
 * within walking distance of stations on line L. Targets the
 * underground-tube case where the HSMM has no positive emission
 * signal for the specific line but the structural evidence
 * (bookend fixes at L's stations) makes train @ L the obviously
 * right pick.
 */

const KX_LAT = 51.5308;
const KX_LON = -0.1238;
const FINCHLEY_LAT = 51.5474;
const FINCHLEY_LON = -0.1809;
const WEMBLEY_LAT = 51.5638;
const WEMBLEY_LON = -0.2796;

const MET_STATIONS = [
	{ lat: KX_LAT, lon: KX_LON }, // King's Cross
	{ lat: FINCHLEY_LAT, lon: FINCHLEY_LON }, // Finchley Road
	{ lat: WEMBLEY_LAT, lon: WEMBLEY_LON }, // Wembley Park
];
const VICTORIA_STATIONS = [
	{ lat: 51.4965, lon: -0.1444 }, // Victoria
	{ lat: 51.5034, lon: -0.1276 }, // Green Park (Victoria + Jubilee)
];

const STATIONS_BY_LINE = new Map([
	["Metropolitan Line", MET_STATIONS],
	["Victoria Line", VICTORIA_STATIONS],
]);

function train(lineName: string | null): State {
	return { mode: "train", placeId: null, lineName };
}

function obs(over: Partial<Observation> = {}): Observation {
	return {
		ts: 1_700_000_000,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 12,
		dayOfWeekLocal: 1,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

describe("buildRailCorridorBoost", () => {
	it("returns 0 for non-train states", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		expect(fn({ mode: "stationary", placeId: 1, lineName: null }, obs({}))).toBe(0);
		expect(fn({ mode: "walking", placeId: null, lineName: null }, obs({}))).toBe(0);
	});

	it("returns 0 for train @ unknown_rail (no line geometry to corroborate)", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		expect(fn(train("unknown_rail"), obs({}))).toBe(0);
	});

	it("returns 0 when no prev/next GPS fixes are available", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		expect(fn(train("Metropolitan Line"), obs({}))).toBe(0);
	});

	it("returns 0 when prev OR next fix is far from line's stations", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		const ts = 1_700_000_000;
		// Prev near King's Cross (Met station). Next far from any Met
		// station (south of the river, no Met coverage).
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: 51.4, lon: -0.0 },
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("boosts train @ L when BOTH prev and next fixes are near L's stations AND current minute is GPS-null", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			gps: null,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: FINCHLEY_LAT, lon: FINCHLEY_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBeGreaterThan(2);
	});

	it("does NOT fire when the current minute has GPS — the user is observed, not in a tunnel", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		const ts = 1_700_000_000;
		// Same bookend fixes, but THIS minute also has a fix — boost
		// must not over-rotate this minute into train @ Met just
		// because we're near tube stations.
		const o = obs({
			ts,
			gps: { lat: KX_LAT, lon: KX_LON, speedKmh: 0 },
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: FINCHLEY_LAT, lon: FINCHLEY_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("does NOT fire when the bookend gap is too short — indoor flicker, not a tube ride", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		const ts = 1_700_000_000;
		// Both fixes at the same station, only 2 minutes apart. This
		// is the central-London indoor flicker case (Work between
		// rooms), not a Met ride.
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 60, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 60, lat: KX_LAT + 0.0005, lon: KX_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("does NOT fire when the bookend distance is too short — user did not actually go anywhere", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		const ts = 1_700_000_000;
		// Long enough gap (10 min) but the fixes are essentially the
		// same location — the user didn't ride anywhere.
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 300, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 300, lat: KX_LAT, lon: KX_LON + 0.001 }, // ~60 m
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("targets the specific line: Met boost fires for Met stations, not Victoria stations", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		const ts = 1_700_000_000;
		// Both fixes near Met stations (King's Cross + Finchley).
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: FINCHLEY_LAT, lon: FINCHLEY_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBeGreaterThan(0);
		// Same fixes but Victoria Line — Finchley Rd is not on Victoria.
		expect(fn(train("Victoria Line"), o)).toBe(0);
	});

	it("returns 0 for unknown line names not in the stations map", () => {
		const fn = buildRailCorridorBoost({ stationsByLine: STATIONS_BY_LINE });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: FINCHLEY_LAT, lon: FINCHLEY_LON },
		});
		expect(fn(train("Hammerhead Express Line"), o)).toBe(0);
	});
});
