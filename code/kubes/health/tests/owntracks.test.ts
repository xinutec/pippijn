import { describe, expect, it } from "vitest";
import { classifyMotion, decideRemoteConfig, type MotionProfile } from "../src/routes/owntracks.js";

describe("classifyMotion", () => {
	// Coarse motion regimes derived from a single velocity reading.
	// Used to drive Owntracks remote config — each regime maps to a
	// different fix-density / battery trade-off.

	it("returns transit-fast for sustained high speed (> 80 km/h)", () => {
		expect(classifyMotion(120)).toBe("transit-fast");
		expect(classifyMotion(300)).toBe("transit-fast"); // train, plane
	});

	it("returns transit for moderate speed (30 < v <= 80 km/h)", () => {
		expect(classifyMotion(50)).toBe("transit");
		expect(classifyMotion(70)).toBe("transit");
	});

	it("returns stationary for very low speed (< 5 km/h)", () => {
		expect(classifyMotion(0)).toBe("stationary");
		expect(classifyMotion(2)).toBe("stationary");
	});

	it("returns null for ambiguous mid-range (5-30 km/h)", () => {
		// Walking, cycling, slow drives — too many possibilities to make
		// a confident server-side decision. Don't push a profile.
		expect(classifyMotion(7)).toBeNull();
		expect(classifyMotion(20)).toBeNull();
	});

	it("uses strict boundaries (< and >)", () => {
		expect(classifyMotion(5)).toBeNull(); // not stationary
		expect(classifyMotion(30)).toBeNull(); // not transit
		expect(classifyMotion(80)).toBe("transit"); // exactly 80 is still transit, not fast
	});
});

describe("decideRemoteConfig", () => {
	// Produces an Owntracks configuration patch when the motion profile
	// has changed from what was last pushed. The patch is a partial
	// configuration — only fields we want to change are included.

	it("returns the config for transit-fast when not yet set", () => {
		const r = decideRemoteConfig(120, null);
		expect(r.profile).toBe("transit-fast");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 10 });
	});

	it("returns the config for transit when transitioning from stationary", () => {
		const r = decideRemoteConfig(50, "stationary");
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("returns the config for stationary when leaving transit", () => {
		const r = decideRemoteConfig(0, "transit");
		expect(r.profile).toBe("stationary");
		expect(r.patch).toEqual({ monitoring: 1 });
	});

	it("returns null patch when profile equals lastProfile (avoid spam)", () => {
		expect(decideRemoteConfig(120, "transit-fast").patch).toBeNull();
		expect(decideRemoteConfig(50, "transit").patch).toBeNull();
		expect(decideRemoteConfig(0, "stationary").patch).toBeNull();
	});

	it("returns null patch for ambiguous speeds (no profile)", () => {
		const r = decideRemoteConfig(20, "transit");
		expect(r.profile).toBe("transit"); // keep lastProfile
		expect(r.patch).toBeNull();
	});

	it("transitions from fast to slow transit pushes the new interval", () => {
		// e.g., train slowing into a station, dropping from 100 to 60 km/h.
		// We want the moveModeLocatorInterval to relax from 10s to 15s.
		const r = decideRemoteConfig(60, "transit-fast");
		expect(r.profile).toBe("transit");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 15 });
	});

	it("type guards: patch is a Partial<OwntracksConfig>-like object", () => {
		const r = decideRemoteConfig(120, null);
		if (r.patch !== null) {
			expect(typeof r.patch.monitoring).toBe("number");
			expect(typeof r.patch.moveModeLocatorInterval).toBe("number");
		}
	});

	it("MotionProfile type narrows to a finite set", () => {
		const p: MotionProfile = "transit";
		expect(["transit-fast", "transit", "stationary", null]).toContain(p);
	});
});
