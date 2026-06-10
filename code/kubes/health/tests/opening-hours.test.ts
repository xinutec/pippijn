/**
 * opening_hours subset parser.
 *
 * The OSM mirror stores every venue's raw tags (osm_points.tags_json), and
 * ~30-50% of venue-class POIs carry `opening_hours`. The venue-plausibility
 * scorer uses "was this venue even open during the stay" as weighted
 * evidence — so the parser must be *honest about its limits*: anything
 * outside the common subset (sunrise/sunset, week numbers, months) parses
 * to null, which the scorer treats as NO evidence, never as "closed".
 *
 * Grammar subset: rules split on ";", each rule = optional day spec
 * (Mo-Fr / Sa,Su / wrapping Sa-Mo) + time ranges (HH:MM-HH:MM, comma
 * separated, may wrap past midnight) or "off"/"closed". Later rules
 * override earlier ones for the days they cover (OSM semantics). PH/SH
 * (public/school holiday) day tokens are dropped — holidays are
 * unknowable here; a pure "PH off" rule is skipped entirely rather than
 * blanking the whole week.
 *
 * All venue strings below are synthetic.
 */

import { describe, expect, it } from "vitest";
import { isOpenAt, openFractionDuring, parseOpeningHours } from "../src/geo/opening-hours.js";

// Day indices: 0 = Monday .. 6 = Sunday.
const MO = 0;
const TU = 1;
const WE = 2;
const FR = 4;
const SA = 5;
const SU = 6;

describe("parseOpeningHours", () => {
	it("parses 24/7 as always open", () => {
		const spec = parseOpeningHours("24/7");
		expect(spec).not.toBeNull();
		for (let d = 0; d < 7; d++) {
			expect(isOpenAt(spec!, d, 0)).toBe(true);
			expect(isOpenAt(spec!, d, 12 * 60)).toBe(true);
			expect(isOpenAt(spec!, d, 23 * 60 + 59)).toBe(true);
		}
	});

	it("parses a restaurant-style split-service week", () => {
		const spec = parseOpeningHours(
			"Mo-Fr 12:00-14:30, 18:30-22:30; Sa 12:00-15:00, 18:30-22:30; Su 12:30-15:30, 18:30-22:30",
		);
		expect(spec).not.toBeNull();
		// Tuesday dinner service
		expect(isOpenAt(spec!, TU, 19 * 60)).toBe(true);
		// Tuesday between services
		expect(isOpenAt(spec!, TU, 16 * 60)).toBe(false);
		// Sunday lunch starts later than weekdays
		expect(isOpenAt(spec!, SU, 12 * 60)).toBe(false);
		expect(isOpenAt(spec!, SU, 12 * 60 + 45)).toBe(true);
	});

	it("leaves unmentioned days closed", () => {
		const spec = parseOpeningHours("Mo-Sa 09:00-17:30");
		expect(spec).not.toBeNull();
		expect(isOpenAt(spec!, SA, 10 * 60)).toBe(true);
		expect(isOpenAt(spec!, SU, 10 * 60)).toBe(false);
	});

	it("lets a later rule override an earlier one (We off)", () => {
		const spec = parseOpeningHours("Mo-Sa 08:00-18:00; We off");
		expect(spec).not.toBeNull();
		expect(isOpenAt(spec!, TU, 10 * 60)).toBe(true);
		expect(isOpenAt(spec!, WE, 10 * 60)).toBe(false);
	});

	it("skips PH/SH rules without blanking the week", () => {
		const spec = parseOpeningHours("Mo-Fr 09:00-17:00; PH off");
		expect(spec).not.toBeNull();
		expect(isOpenAt(spec!, MO, 10 * 60)).toBe(true);
	});

	it("drops a PH token mixed into a day list but keeps the real days", () => {
		const spec = parseOpeningHours("Mo-Fr,PH 09:00-17:00");
		expect(spec).not.toBeNull();
		expect(isOpenAt(spec!, FR, 10 * 60)).toBe(true);
		expect(isOpenAt(spec!, SA, 10 * 60)).toBe(false);
	});

	it("handles day lists and ranges combined", () => {
		const spec = parseOpeningHours("Mo,We-Fr 10:00-16:00");
		expect(spec).not.toBeNull();
		expect(isOpenAt(spec!, MO, 11 * 60)).toBe(true);
		expect(isOpenAt(spec!, TU, 11 * 60)).toBe(false);
		expect(isOpenAt(spec!, WE, 11 * 60)).toBe(true);
		expect(isOpenAt(spec!, FR, 11 * 60)).toBe(true);
	});

	it("handles a day range wrapping the week (Sa-Mo)", () => {
		const spec = parseOpeningHours("Sa-Mo 10:00-16:00");
		expect(spec).not.toBeNull();
		expect(isOpenAt(spec!, SA, 11 * 60)).toBe(true);
		expect(isOpenAt(spec!, SU, 11 * 60)).toBe(true);
		expect(isOpenAt(spec!, MO, 11 * 60)).toBe(true);
		expect(isOpenAt(spec!, TU, 11 * 60)).toBe(false);
	});

	it("handles a time range wrapping past midnight", () => {
		const spec = parseOpeningHours("Fr-Sa 20:00-02:00");
		expect(spec).not.toBeNull();
		expect(isOpenAt(spec!, FR, 21 * 60)).toBe(true);
		// 01:00 Saturday is inside Friday's wrapped range
		expect(isOpenAt(spec!, SA, 1 * 60)).toBe(true);
		// 03:00 Saturday is after close
		expect(isOpenAt(spec!, SA, 3 * 60)).toBe(false);
		// 01:00 Sunday is inside Saturday's wrapped range
		expect(isOpenAt(spec!, SU, 1 * 60)).toBe(true);
		// 01:00 Friday is NOT open (Thursday has no range)
		expect(isOpenAt(spec!, FR, 1 * 60)).toBe(false);
	});

	it("treats a bare time range as every day", () => {
		const spec = parseOpeningHours("08:00-20:00");
		expect(spec).not.toBeNull();
		expect(isOpenAt(spec!, MO, 12 * 60)).toBe(true);
		expect(isOpenAt(spec!, SU, 12 * 60)).toBe(true);
		expect(isOpenAt(spec!, SU, 21 * 60)).toBe(false);
	});

	it("is case-tolerant on day names", () => {
		const spec = parseOpeningHours("mo-fr 09:00-17:00");
		expect(spec).not.toBeNull();
		expect(isOpenAt(spec!, MO, 10 * 60)).toBe(true);
	});

	it.each([
		["", "empty"],
		["sunrise-sunset", "solar events"],
		["Mo-Fr 09:00-17:00 garbage", "trailing junk"],
		["Jan-Mar 09:00-17:00", "month spec"],
		["Mo-Fr 09:00+", "open-ended time"],
		["week 1-26 Mo 09:00-17:00", "week numbers"],
	])("returns null on %s (%s) — no evidence, not closed", (value) => {
		expect(parseOpeningHours(value)).toBeNull();
	});

	it("returns null when every rule is a skipped holiday rule", () => {
		expect(parseOpeningHours("PH off")).toBeNull();
	});
});

describe("openFractionDuring", () => {
	// 2026-06-09 is a Tuesday. Europe/London is UTC+1 (BST) on that date.
	// 18:00 local = 17:00 UTC.
	const tueLocal = (h: number, m: number): number => Date.UTC(2026, 5, 9, h - 1, m) / 1000;

	it("returns 1 for a stay fully inside dinner service", () => {
		const spec = parseOpeningHours("Mo-Fr 12:00-14:30, 18:30-22:30")!;
		const frac = openFractionDuring(spec, tueLocal(19, 0), tueLocal(20, 15), "Europe/London");
		expect(frac).toBe(1);
	});

	it("returns 0 for a stay while closed", () => {
		const spec = parseOpeningHours("Mo-Fr 09:00-18:00")!;
		const frac = openFractionDuring(spec, tueLocal(19, 0), tueLocal(20, 15), "Europe/London");
		expect(frac).toBe(0);
	});

	it("returns the overlapped fraction for a stay straddling opening time", () => {
		const spec = parseOpeningHours("Mo-Fr 18:30-22:30")!;
		// 17:30-19:30 local: open for the final hour of a two-hour stay.
		const frac = openFractionDuring(spec, tueLocal(17, 30), tueLocal(19, 30), "Europe/London");
		expect(frac).toBeGreaterThan(0.45);
		expect(frac).toBeLessThan(0.55);
	});

	it("evaluates an instant (zero-length window) at its start", () => {
		const spec = parseOpeningHours("Mo-Fr 18:30-22:30")!;
		expect(openFractionDuring(spec, tueLocal(19, 0), tueLocal(19, 0), "Europe/London")).toBe(1);
		expect(openFractionDuring(spec, tueLocal(17, 0), tueLocal(17, 0), "Europe/London")).toBe(0);
	});

	it("respects the timezone, not UTC", () => {
		const spec = parseOpeningHours("Mo-Fr 18:30-22:30")!;
		// 16:45 UTC = 18:45 Paris (CEST, open) vs 17:45 London (BST, closed).
		const t = Date.UTC(2026, 5, 9, 16, 45) / 1000;
		expect(openFractionDuring(spec, t, t, "Europe/Paris")).toBe(1);
		expect(openFractionDuring(spec, t, t, "Europe/London")).toBe(0);
	});
});
