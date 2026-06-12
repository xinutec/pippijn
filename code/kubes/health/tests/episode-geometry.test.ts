import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "../src/cli/fixture-day.js";
import { buildEpisodes } from "../src/geo/episode-geometry.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { computeVelocityFromInputs, type EnrichedSegment, type VelocityResult } from "../src/geo/velocity.js";
import type { DayState, DayStateMode } from "../src/sleep/day-state.js";
import { describeWithFixture } from "./helpers/describe-with-fixture.js";

// Minimal factories — buildEpisodes reads only a handful of fields, so we
// construct partial objects and cast. Keeping them minimal documents
// exactly what the geometry layer depends on.
function fix(ts: number, lat: number, lon: number, speed_kmh: number): FilteredPoint {
	return { ts, lat, lon, speed_kmh, bearing: 0 };
}
function state(startTs: number, endTs: number, mode: DayStateMode): DayState {
	return { startTs, endTs, mode };
}
function seg(partial: Partial<EnrichedSegment> & { startTs: number; endTs: number; mode: string }): EnrichedSegment {
	return partial as EnrichedSegment;
}

describe("buildEpisodes — per-mode speed-plausibility filter", () => {
	it("drops walking fixes above the 12 km/h ceiling, keeps the slow walk", () => {
		const fixes = [
			fix(1000, 51.5, -0.27, 60), // train bleed — drop
			fix(1020, 51.51, -0.275, 55), // train bleed — drop
			fix(1040, 51.0, -0.1, 8), // genuine walk — keep
			fix(1060, 51.001, -0.1, 4),
			fix(1080, 51.002, -0.1, 3),
		];
		const [ep] = buildEpisodes([state(1000, 1100, "walking")], [], fixes);
		expect(ep.kind).toBe("raw");
		expect(ep.points).toHaveLength(3);
		// None of the dropped fast fixes survive.
		expect(ep.points.some((p) => p.lat === 51.5 || p.lat === 51.51)).toBe(false);
		expect(ep.points.every((p) => p.lat >= 51.0 && p.lat < 51.01)).toBe(true);
	});

	it("uses the cycling ceiling (35), not the walking one", () => {
		const fixes = [fix(0, 51, -0.1, 50), fix(20, 51.001, -0.1, 30), fix(40, 51.002, -0.1, 28)];
		const [ep] = buildEpisodes([state(0, 100, "cycling")], [], fixes);
		expect(ep.points.some((p) => p.lat === 51)).toBe(false); // 50 km/h dropped
		expect(ep.points).toHaveLength(2); // the two ≤35 kept
	});

	it("never filters a vehicle mode — a 90 km/h drive is kept", () => {
		const fixes = [fix(0, 51, -0.1, 90), fix(20, 51.01, -0.1, 95), fix(40, 51.02, -0.1, 88)];
		const [ep] = buildEpisodes([state(0, 100, "driving")], [], fixes);
		expect(ep.kind).toBe("raw");
		expect(ep.points).toHaveLength(3); // none dropped
	});
});

describe("buildEpisodes — per-mode geometry resolution", () => {
	it("draws a cached train as snapped, clipped to the state window", () => {
		const segs = [
			seg({
				startTs: 0,
				endTs: 100,
				mode: "train",
				snappedPath: [
					{ ts: 0, lat: 51.0, lon: -0.1 },
					{ ts: 50, lat: 51.05, lon: -0.15 },
					{ ts: 100, lat: 51.1, lon: -0.2 },
				],
			}),
		];
		const [ep] = buildEpisodes([state(0, 100, "train")], segs, []);
		expect(ep.kind).toBe("snapped");
		expect(ep.points).toHaveLength(3);
		expect(ep.points[0]).toEqual({ lat: 51.0, lon: -0.1 });
	});

	it("draws an uncached train raw from its own fixes (no speed filter)", () => {
		const segs = [seg({ startTs: 0, endTs: 100, mode: "train" })];
		const fixes = [fix(0, 51, -0.1, 90), fix(50, 51.05, -0.15, 95), fix(100, 51.1, -0.2, 80)];
		const [ep] = buildEpisodes([state(0, 100, "train")], segs, fixes);
		expect(ep.kind).toBe("raw");
		expect(ep.points).toHaveLength(3); // fast train fixes kept — train has no ceiling
	});

	it("collapses a stay to a single anchor at the segment centroid", () => {
		const segs = [seg({ startTs: 0, endTs: 100, mode: "stationary", centroidLat: 51.5, centroidLon: -0.12 })];
		const [ep] = buildEpisodes([state(0, 100, "stationary")], segs, [fix(10, 51.6, -0.2, 0)]);
		expect(ep.kind).toBe("anchor");
		expect(ep.points).toEqual([{ lat: 51.5, lon: -0.12 }]); // centroid wins over the fix
	});

	it("emits an empty episode for a synthesized pre-fix sleep (no segment, no fixes)", () => {
		const [ep] = buildEpisodes([state(0, 100, "sleeping")], [], []);
		expect(ep.kind).toBe("anchor");
		expect(ep.points).toHaveLength(0);
	});

	it("bridges a short unknown gap, but not a cross-city one", () => {
		const a = seg({ startTs: 0, endTs: 100, mode: "stationary", centroidLat: 51.5, centroidLon: -0.12 });
		const near = seg({ startTs: 200, endTs: 300, mode: "stationary", centroidLat: 51.505, centroidLon: -0.12 });
		const states = [state(0, 100, "stationary"), state(100, 200, "unknown"), state(200, 300, "stationary")];
		const [, gap] = buildEpisodes(states, [a, near], []);
		expect(gap.kind).toBe("tentative");
		expect(gap.points).toHaveLength(2); // ~560 m apart, under the 2 km cap

		const far = seg({ startTs: 200, endTs: 300, mode: "stationary", centroidLat: 51.6, centroidLon: -0.12 });
		const [, gap2] = buildEpisodes(states, [a, far], []);
		expect(gap2.points).toHaveLength(0); // ~11 km apart, over the cap → draw nothing
	});

	it("rejects a teleport spike from a raw moving episode", () => {
		const fixes = [
			fix(0, 51.0, -0.1, 5),
			fix(20, 60.0, 10.0, 5), // teleport spike
			fix(40, 51.0005, -0.1, 5),
		];
		const [ep] = buildEpisodes([state(0, 100, "walking")], [], fixes);
		expect(ep.points.some((p) => p.lat === 60)).toBe(false);
	});
});

// Real-data grounding (gitignored fixture; skipped in CI). A captured
// day in which a train's overground deceleration into its alighting
// station is mis-segmented into the following walking episode — the
// walk's leading fixes carry vehicle speed (≫12 km/h). The speed filter
// drops them; the genuine slow walk survives. Cache-independent: the
// filter never consults snappedPath.
function loadCaptured(): CapturedDay | null {
	try {
		return parseCapturedDay(readFileSync("tests/golden/days/2026-06-09-pippijn.json", "utf8"));
	} catch {
		return null;
	}
}

describeWithFixture("buildEpisodes — train-tail bleed into a walk (real data)", loadCaptured(), (captured) => {
	let result: VelocityResult;
	let inputs: ReturnType<typeof inputsFromFixture>;

	beforeAll(async () => {
		inputs = inputsFromFixture(captured);
		result = await computeVelocityFromInputs(inputs);
	});

	function speedOf(p: { lat: number; lon: number }): number | undefined {
		return result.points.find((f) => f.lat === p.lat && f.lon === p.lon)?.speed_kmh;
	}

	it("draws no walking/cycling point above its mode's ceiling", () => {
		const caps: Record<string, number> = { walking: 12, cycling: 35 };
		for (const ep of buildEpisodes(result.states, result.segments, result.points)) {
			const cap = caps[ep.mode];
			if (cap === undefined) continue;
			for (const p of ep.points) {
				const s = speedOf(p);
				if (s !== undefined) expect(s).toBeLessThanOrEqual(cap);
			}
		}
	});

	it("removes a walking episode's vehicle-speed lead-in fixes but keeps the slow walk", () => {
		const episodes = buildEpisodes(result.states, result.segments, result.points);
		// The affected walk: a walking episode whose raw window holds
		// vehicle-speed fixes (>40 km/h) — a faster mode bled across the
		// boundary.
		const windowFixes = (e: { startTs: number; endTs: number }) =>
			result.points.filter((f) => f.ts >= e.startTs && f.ts <= e.endTs);
		const walk = episodes.find((e) => e.mode === "walking" && windowFixes(e).some((f) => f.speed_kmh > 40));
		expect(walk, "expected a walking episode with bled-in fast fixes").toBeDefined();
		if (!walk) return;

		const win = windowFixes(walk);
		expect(win.some((f) => f.speed_kmh > 40)).toBe(true); // the bleed is in the raw data…
		expect(walk.points.length).toBeLessThan(win.length); // …and the filter dropped some…
		expect(walk.points.length).toBeGreaterThan(0); // …but the genuine slow walk survives.
		// Every drawn point's source fix is plausibly walking.
		for (const p of walk.points) {
			const s = speedOf(p);
			if (s !== undefined) expect(s).toBeLessThanOrEqual(12);
		}
	});

	it("is identical with the rail-route cache emptied (no snappedPath dependence)", async () => {
		const withCache = buildEpisodes(result.states, result.segments, result.points).filter((e) => e.mode === "walking");
		const noCacheResult = await computeVelocityFromInputs({ ...inputs, railRouteCache: [] });
		const withoutCache = buildEpisodes(noCacheResult.states, noCacheResult.segments, noCacheResult.points).filter(
			(e) => e.mode === "walking",
		);
		expect(withoutCache).toEqual(withCache);
	});
});
