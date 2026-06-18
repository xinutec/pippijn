import { describe, expect, it } from "vitest";
import { checkDayConstraints, parseStationPair } from "../src/infer/day-grammar.js";
import type { DayState, DayStateMode } from "../src/sleep/day-state.js";

let t = 0;
function st(mode: DayStateMode, extra: Partial<DayState> = {}): DayState {
	const s: DayState = { startTs: t, endTs: t + 600, mode, ...extra };
	t += 600;
	return s;
}

describe("parseStationPair", () => {
	it("parses a board → alight · line label", () => {
		expect(parseStationPair("Euston Square → Wembley Park · Metropolitan Line")).toEqual({
			board: "Euston Square",
			alight: "Wembley Park",
		});
	});
	it("returns null for a road name or absent label", () => {
		expect(parseStationPair("Euston Underpass")).toBeNull();
		expect(parseStationPair(undefined)).toBeNull();
	});
});

describe("checkDayConstraints", () => {
	it("passes a physically-possible day", () => {
		t = 0;
		const day = [
			st("sleeping", { place: "Home" }),
			st("walking"),
			st("train", { wayName: "Wembley Park → Euston Square · Metropolitan Line" }),
			st("walking"),
			st("stationary", { place: "UCLH" }),
			st("walking"),
			st("train", { wayName: "Euston Square → Wembley Park · Metropolitan Line" }),
			st("walking"),
			st("stationary", { place: "Home" }),
		];
		expect(checkDayConstraints(day)).toEqual([]);
	});

	it("flags a direct vehicle→vehicle hand-off (the 2026-06-18 driving→tube)", () => {
		t = 0;
		const day = [
			st("walking"),
			st("driving", { wayName: "Euston Underpass" }),
			st("train", { wayName: "Euston Square → Wembley Park · Metropolitan Line" }),
			st("walking"),
		];
		const v = checkDayConstraints(day);
		expect(v).toHaveLength(1);
		expect(v[0].constraint).toBe("vehicle-handoff");
		expect(v[0].index).toBe(1);
	});

	it("does NOT flag a train→train interchange (same mode, different line)", () => {
		t = 0;
		const day = [
			st("train", { wayName: "A → B · Jubilee Line" }),
			st("train", { wayName: "B → C · Metropolitan Line" }),
		];
		expect(checkDayConstraints(day)).toEqual([]);
	});

	it("flags a teleport between two distinct at-rest places", () => {
		t = 0;
		const day = [st("stationary", { place: "Work" }), st("stationary", { place: "Home" })];
		const v = checkDayConstraints(day);
		expect(v).toHaveLength(1);
		expect(v[0].constraint).toBe("stay-teleport");
	});

	it("flags a transit leg that boards and alights at the same station", () => {
		t = 0;
		const day = [st("train", { wayName: "Baker Street → Baker Street · Circle Line" })];
		const v = checkDayConstraints(day);
		expect(v).toHaveLength(1);
		expect(v[0].constraint).toBe("transit-same-endpoint");
	});

	it("allows a vehicle bracketed by walking on both sides", () => {
		t = 0;
		const day = [st("walking"), st("bus", { wayName: "Stop A → Stop B · 38" }), st("walking"), st("driving")];
		// bus→walking→driving: the walking separates the two vehicles, so legal.
		expect(checkDayConstraints(day)).toEqual([]);
	});
});
