import { describe, expect, it } from "vitest";
import type { FactorContext, ModeCandidate } from "../../src/geo/factors/types.js";
import { wayPresence } from "../../src/geo/factors/way-presence.js";

const NO_CTX: FactorContext = {};

describe("wayPresence", () => {
	it("returns a positive bonus for a candidate carrying way info", () => {
		const candidate: ModeCandidate = {
			mode: "walking",
			wayName: "Barn Rise",
			waySubtype: "residential",
			wayDistanceM: 15,
		};
		const score = wayPresence(candidate, NO_CTX);
		expect(score).not.toBeNull();
		expect(score?.score).toBeGreaterThan(0);
	});

	it("returns null for the fallback candidate (no way info — factor doesn't apply)", () => {
		const fallback: ModeCandidate = { mode: "walking" };
		expect(wayPresence(fallback, NO_CTX)).toBeNull();
	});

	it("returns the same bonus regardless of how close the way is", () => {
		const near: ModeCandidate = {
			mode: "walking",
			wayName: "Barn Rise",
			waySubtype: "residential",
			wayDistanceM: 5,
		};
		const far: ModeCandidate = {
			mode: "walking",
			wayName: "Barn Rise",
			waySubtype: "residential",
			wayDistanceM: 100,
		};
		expect(wayPresence(near, NO_CTX)?.score).toBe(wayPresence(far, NO_CTX)?.score);
	});

	it("returns the same bonus regardless of mode (factor is mode-agnostic)", () => {
		const walking: ModeCandidate = { mode: "walking", waySubtype: "footway", wayDistanceM: 8 };
		const driving: ModeCandidate = { mode: "driving", waySubtype: "motorway", wayDistanceM: 8 };
		const train: ModeCandidate = { mode: "train", waySubtype: "subway", wayDistanceM: 8 };
		const s = wayPresence(walking, NO_CTX)?.score;
		expect(wayPresence(driving, NO_CTX)?.score).toBe(s);
		expect(wayPresence(train, NO_CTX)?.score).toBe(s);
	});

	it("returns null for an unnamed way (no labelable evidence — same as fallback for renderer)", () => {
		// The renderer outputs `on <wayName>` only — a candidate
		// with wayDistanceM/waySubtype but no wayName produces the
		// same user-visible string as the fallback ("walking" with
		// no label). So way-presence — which exists to discriminate
		// label quality — gives no bonus. mode-coherence and
		// osm-distance still reward the unnamed candidate for being
		// spatially correct; this factor doesn't.
		const anonymous: ModeCandidate = { mode: "walking", waySubtype: "footway", wayDistanceM: 12 };
		expect(wayPresence(anonymous, NO_CTX)).toBeNull();
	});

	it("calibration: bonus is large enough that a 15m residential walking beats the fallback", () => {
		// walking-on-residential @ 15m has speed +0.5, osm-dist -0.41,
		// mode-coh 0 → total -0.41 + WP. Fallback walking has +0.5 only.
		// So WP - 0.41 > 0.5 ⇒ WP > 0.91.
		const candidate: ModeCandidate = {
			mode: "walking",
			waySubtype: "residential",
			wayName: "Barn Rise",
			wayDistanceM: 15,
		};
		const score = wayPresence(candidate, NO_CTX);
		expect(score?.score).toBeGreaterThan(0.91);
	});

	it("calibration: bonus is bounded so a 100m-away way still loses to fallback", () => {
		// At 100m osm-distance returns -2.3 nats; fallback gets +0.
		// Need WP < 2.3 for fallback to still beat way-attached at this range.
		const candidate: ModeCandidate = {
			mode: "walking",
			waySubtype: "residential",
			wayName: "Some Far Road",
			wayDistanceM: 100,
		};
		const score = wayPresence(candidate, NO_CTX);
		expect(score?.score).toBeLessThan(2.3);
	});

	it("carries a human-readable rationale", () => {
		const candidate: ModeCandidate = {
			mode: "walking",
			wayName: "Barn Rise",
			waySubtype: "residential",
			wayDistanceM: 15,
		};
		const score = wayPresence(candidate, NO_CTX);
		expect(score?.rationale).toBeDefined();
		expect(score?.rationale).toMatch(/way|attached|presence/i);
	});
});
