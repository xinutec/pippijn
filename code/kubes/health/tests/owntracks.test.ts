import { describe, expect, it } from "vitest";
import {
	classifyFromHistory,
	classifyMotion,
	decideRemoteConfig,
	effectiveSpeedKmh,
	type FixRecord,
	type MotionProfile,
	pruneFixHistory,
	straightnessRatio,
} from "../src/routes/owntracks.js";

/** Build a chain of fixes starting at (lat0, lon0), stepping `dLat`/`dLon`
 *  degrees per fix, with `dtSec` seconds between fixes. The first fix is at
 *  `t0`. Used to construct deterministic walking-shape trajectories. */
function chain(opts: {
	lat0: number;
	lon0: number;
	dLat: number;
	dLon: number;
	t0: number;
	dtSec: number;
	n: number;
}): FixRecord[] {
	const out: FixRecord[] = [];
	for (let i = 0; i < opts.n; i++) {
		out.push({ ts: opts.t0 + i * opts.dtSec, lat: opts.lat0 + i * opts.dLat, lon: opts.lon0 + i * opts.dLon });
	}
	return out;
}

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
		expect(["transit-fast", "transit", "walking", "stationary", null]).toContain(p);
	});
});

describe("pruneFixHistory", () => {
	// Drops fixes older than `now - maxAgeSec`. Used per-request to keep the
	// in-memory history bounded and to give the walking heuristic a fresh
	// window (drift fixes from hours ago shouldn't count toward a walk).

	it("returns empty for empty input", () => {
		expect(pruneFixHistory([], 600, 1_000_000)).toEqual([]);
	});

	it("keeps fixes within the window", () => {
		const h: FixRecord[] = [
			{ ts: 1500, lat: 0, lon: 0 }, // age 500s, within 600s window
			{ ts: 1700, lat: 0, lon: 0 },
			{ ts: 1900, lat: 0, lon: 0 },
		];
		expect(pruneFixHistory(h, 600, 2000)).toEqual(h);
	});

	it("drops fixes older than the cutoff", () => {
		const h: FixRecord[] = [
			{ ts: 100, lat: 0, lon: 0 }, // age 1900s, dropped
			{ ts: 1500, lat: 0, lon: 0 }, // age 500s, kept
			{ ts: 1900, lat: 0, lon: 0 }, // age 100s, kept
		];
		expect(pruneFixHistory(h, 600, 2000)).toEqual([
			{ ts: 1500, lat: 0, lon: 0 },
			{ ts: 1900, lat: 0, lon: 0 },
		]);
	});

	it("preserves chronological order", () => {
		const h: FixRecord[] = [
			{ ts: 1000, lat: 1, lon: 1 },
			{ ts: 1100, lat: 2, lon: 2 },
			{ ts: 1200, lat: 3, lon: 3 },
		];
		const out = pruneFixHistory(h, 600, 1300);
		expect(out.map((f) => f.ts)).toEqual([1000, 1100, 1200]);
	});

	it("keeps the boundary (ts === now - maxAgeSec)", () => {
		// Exactly at the cutoff should be kept — we want inclusive lower bound
		// so the heuristic doesn't drop a fix that just barely fits.
		const out = pruneFixHistory([{ ts: 400, lat: 0, lon: 0 }], 600, 1000);
		expect(out).toEqual([{ ts: 400, lat: 0, lon: 0 }]);
	});
});

describe("effectiveSpeedKmh", () => {
	// Total path distance divided by total elapsed time. Distinguishes "GPS
	// jitter while stationary" (low speed) from "actually moving" (real
	// speed). Computed across the whole window, not just the latest segment.

	it("returns 0 for empty / single-fix history", () => {
		expect(effectiveSpeedKmh([])).toBe(0);
		expect(effectiveSpeedKmh([{ ts: 0, lat: 0, lon: 0 }])).toBe(0);
	});

	it("returns 0 when total elapsed time is 0", () => {
		// Two fixes with the same timestamp would yield divide-by-zero
		// otherwise. Real phones can theoretically batch-emit fixes at the
		// same tst — guard against it.
		expect(
			effectiveSpeedKmh([
				{ ts: 1000, lat: 0, lon: 0 },
				{ ts: 1000, lat: 0.001, lon: 0 },
			]),
		).toBe(0);
	});

	it("computes ~6 km/h for 100m over 60s", () => {
		// At the equator, 0.0009 degrees latitude ≈ 100m.
		const h: FixRecord[] = [
			{ ts: 1000, lat: 0, lon: 0 },
			{ ts: 1060, lat: 0.0009, lon: 0 },
		];
		expect(effectiveSpeedKmh(h)).toBeCloseTo(6, 0);
	});

	it("sums path distance across multiple fixes", () => {
		// Three fixes, each 100m apart, 60s apart. Path = 200m, time = 120s.
		// Effective speed = 6 km/h.
		const h: FixRecord[] = [
			{ ts: 1000, lat: 0, lon: 0 },
			{ ts: 1060, lat: 0.0009, lon: 0 },
			{ ts: 1120, lat: 0.0018, lon: 0 },
		];
		expect(effectiveSpeedKmh(h)).toBeCloseTo(6, 0);
	});
});

describe("straightnessRatio", () => {
	// Net displacement (first → last) divided by total path distance. Real
	// walking yields >0.5 because you're heading somewhere; GPS jitter while
	// stationary yields near 0 (path bounces around, net displacement small).

	it("returns 0 for empty / single-fix history", () => {
		expect(straightnessRatio([])).toBe(0);
		expect(straightnessRatio([{ ts: 0, lat: 0, lon: 0 }])).toBe(0);
	});

	it("returns 0 when path distance is 0 (all same point)", () => {
		const h: FixRecord[] = [
			{ ts: 0, lat: 1, lon: 1 },
			{ ts: 60, lat: 1, lon: 1 },
			{ ts: 120, lat: 1, lon: 1 },
		];
		expect(straightnessRatio(h)).toBe(0);
	});

	it("returns ~1 for a perfectly colinear walk", () => {
		const h = chain({ lat0: 0, lon0: 0, dLat: 0.0009, dLon: 0, t0: 0, dtSec: 60, n: 5 });
		expect(straightnessRatio(h)).toBeCloseTo(1, 5);
	});

	it("returns ~0.707 for a 90-degree L-shape with equal legs", () => {
		// 100m east, then 100m north. Net = sqrt(2)*100 ≈ 141m, path = 200m.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 60, lat: 0, lon: 0.0009 }, // 100m east
			{ ts: 120, lat: 0.0009, lon: 0.0009 }, // 100m north
		];
		expect(straightnessRatio(h)).toBeCloseTo(Math.SQRT1_2, 1);
	});

	it("returns ~0 for a back-and-forth wander (return to start)", () => {
		// Go out 100m, come back. Path = 200m, net ≈ 0.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 60, lat: 0.0009, lon: 0 },
			{ ts: 120, lat: 0, lon: 0 },
		];
		expect(straightnessRatio(h)).toBeLessThan(0.05);
	});

	it("stays high for a slightly noisy walk (real-world tolerance)", () => {
		// Mostly heading north with small east/west wobble. Still clearly
		// directional — the heuristic must not punish realistic GPS noise.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 60, lat: 0.0009, lon: 0.00005 },
			{ ts: 120, lat: 0.0018, lon: -0.00005 },
			{ ts: 180, lat: 0.0027, lon: 0.00003 },
			{ ts: 240, lat: 0.0036, lon: 0 },
		];
		expect(straightnessRatio(h)).toBeGreaterThan(0.9);
	});
});

describe("classifyFromHistory", () => {
	// Returns "walking" when the recent fix history shows directional motion
	// in the walking-speed band, null otherwise. Caller is responsible for
	// pruning the history to the desired time window first.

	it("returns null when fewer than 3 fixes are available", () => {
		expect(classifyFromHistory([])).toBeNull();
		expect(classifyFromHistory([{ ts: 0, lat: 0, lon: 0 }])).toBeNull();
		expect(
			classifyFromHistory([
				{ ts: 0, lat: 0, lon: 0 },
				{ ts: 60, lat: 0.0009, lon: 0 },
			]),
		).toBeNull();
	});

	it("returns 'walking' for a straight 4 km/h trajectory over 4 fixes", () => {
		// 100m every 90s → 4 km/h, perfectly colinear.
		const h = chain({ lat0: 0, lon0: 0, dLat: 0.0009, dLon: 0, t0: 0, dtSec: 90, n: 4 });
		expect(classifyFromHistory(h)).toBe("walking");
	});

	it("returns 'walking' for a slightly bent walk (straightness ~0.7)", () => {
		// L-shape walk at ~4 km/h. Straightness ~0.707, above the 0.5 cutoff.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 90, lat: 0, lon: 0.0009 },
			{ ts: 180, lat: 0, lon: 0.0018 },
			{ ts: 270, lat: 0.0009, lon: 0.0018 },
			{ ts: 360, lat: 0.0018, lon: 0.0018 },
		];
		expect(classifyFromHistory(h)).toBe("walking");
	});

	it("returns null for a wandering walk (low straightness)", () => {
		// 4 km/h effective speed but circling around — no clear direction.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 90, lat: 0.0009, lon: 0 },
			{ ts: 180, lat: 0.0009, lon: 0.0009 },
			{ ts: 270, lat: 0, lon: 0.0009 },
			{ ts: 360, lat: 0, lon: 0 }, // back to start
		];
		expect(classifyFromHistory(h)).toBeNull();
	});

	it("returns null for slow drift (under walking-speed lower bound)", () => {
		// 0.5 km/h — GPS noise while standing still, even if "straight".
		// Net ~50m over 6 minutes. Walking band starts at 2 km/h.
		const h: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 120, lat: 0.0001, lon: 0 },
			{ ts: 240, lat: 0.0002, lon: 0 },
			{ ts: 360, lat: 0.0003, lon: 0 },
		];
		expect(classifyFromHistory(h)).toBeNull();
	});

	it("returns null when speed exceeds the walking band (let single-fix path handle it)", () => {
		// 18 km/h over a straight line — cycling or slow driving. The
		// single-fix classifier already covers transit speeds well; the
		// history heuristic only fills in the walking gap, so return null
		// here and let the caller's transit/transit-fast path decide.
		const h = chain({ lat0: 0, lon0: 0, dLat: 0.0045, dLon: 0, t0: 0, dtSec: 90, n: 4 });
		expect(classifyFromHistory(h)).toBeNull();
	});
});

describe("decideRemoteConfig with history", () => {
	// History is the multi-fix walking signal; single-fix speed is the
	// transit / stationary signal. High single-fix speed wins (faster to
	// react when boarding a train); otherwise history overrides the
	// stationary fallback so a 4 km/h "walk" doesn't read as stationary.

	const walkingHistory = chain({ lat0: 0, lon0: 0, dLat: 0.0009, dLon: 0, t0: 0, dtSec: 90, n: 4 });

	it("pushes 'walking' patch when history is walking and speed is sub-stationary", () => {
		// Owntracks `vel` can be unreported or zero on the first walking
		// fix — but the historical fixes already show a walk in progress.
		const r = decideRemoteConfig(0, null, walkingHistory);
		expect(r.profile).toBe("walking");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 30 });
	});

	it("pushes 'walking' patch when last profile was stationary", () => {
		const r = decideRemoteConfig(0, "stationary", walkingHistory);
		expect(r.profile).toBe("walking");
		expect(r.patch).not.toBeNull();
	});

	it("does not re-push when already walking", () => {
		const r = decideRemoteConfig(0, "walking", walkingHistory);
		expect(r.profile).toBe("walking");
		expect(r.patch).toBeNull();
	});

	it("prefers high single-fix speed over walking history (board train)", () => {
		// History says walking, but the latest fix is a 120 km/h train.
		// The single-fix transit signal is faster — trust it.
		const r = decideRemoteConfig(120, "walking", walkingHistory);
		expect(r.profile).toBe("transit-fast");
		expect(r.patch).toEqual({ monitoring: 2, moveModeLocatorInterval: 10 });
	});

	it("falls back to stationary when history is empty and speed is low", () => {
		// Original behavior preserved when there's no history yet.
		const r = decideRemoteConfig(0, null, []);
		expect(r.profile).toBe("stationary");
		expect(r.patch).toEqual({ monitoring: 1 });
	});

	it("history with wander does not override stationary fallback", () => {
		const wanderHistory: FixRecord[] = [
			{ ts: 0, lat: 0, lon: 0 },
			{ ts: 90, lat: 0.0009, lon: 0 },
			{ ts: 180, lat: 0.0009, lon: 0.0009 },
			{ ts: 270, lat: 0, lon: 0.0009 },
			{ ts: 360, lat: 0, lon: 0 },
		];
		const r = decideRemoteConfig(0, null, wanderHistory);
		expect(r.profile).toBe("stationary");
	});
});
