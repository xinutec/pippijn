import { describe, expect, it } from "vitest";
import { aggregateModeStats, labelMinuteByHeuristic, type MinuteObservation } from "../src/geo/mode-biometrics.js";

describe("labelMinuteByHeuristic", () => {
	// The heuristic labels per-minute observations into a "confident" mode
	// label or null (ambiguous, skip). Designed to produce clean training
	// data for per-user emission stats, accepting that many minutes will
	// be unlabeled.

	it("labels low-speed low-cadence as stationary", () => {
		expect(labelMinuteByHeuristic({ hr: 72, cadence: 0, speed: 0.3 })).toBe("stationary");
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 0.5 })).toBe("stationary");
	});

	it("labels walking-cadence walking-speed as walking", () => {
		// Typical adult walking cadence 100-130 spm, speed 4-6 km/h.
		expect(labelMinuteByHeuristic({ hr: 110, cadence: 110, speed: 5 })).toBe("walking");
		expect(labelMinuteByHeuristic({ hr: 95, cadence: 90, speed: 4 })).toBe("walking");
	});

	it("labels zero-cadence + cycling-speed + elevated-HR as cycling", () => {
		// Cycling has the unique signature: no steps recorded, moderate
		// speed (12-25 km/h), elevated HR.
		expect(labelMinuteByHeuristic({ hr: 130, cadence: 0, speed: 18 })).toBe("cycling");
		expect(labelMinuteByHeuristic({ hr: 140, cadence: 0, speed: 22 })).toBe("cycling");
	});

	it("does NOT label cycling without HR confirmation", () => {
		// Cycling at 18 km/h cadence 0 looks like a slow drive without HR.
		// Refuse to label rather than learn wrong stats.
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 18 })).toBeNull();
	});

	it("does NOT label cycling-speed with sub-cycling HR as cycling", () => {
		// HR too low for cycling — probably a slow drive on a residential
		// road. Skip the label.
		expect(labelMinuteByHeuristic({ hr: 80, cadence: 0, speed: 18 })).toBeNull();
	});

	it("labels high-speed zero-cadence as driving", () => {
		// > 30 km/h with no steps. HR can confirm (low / sitting) but null
		// is fine — no other mode plausibly hits this speed.
		expect(labelMinuteByHeuristic({ hr: 75, cadence: 0, speed: 50 })).toBe("driving");
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 40 })).toBe("driving");
	});

	it("does NOT label driving when HR is high (could be cycling on a hill)", () => {
		// HR 130 at 35 km/h could be a fast cyclist on a descent. Reject
		// to avoid learning wrong-mode stats.
		expect(labelMinuteByHeuristic({ hr: 130, cadence: 0, speed: 35 })).toBeNull();
	});

	it("labels very high speed zero-cadence as train", () => {
		expect(labelMinuteByHeuristic({ hr: 72, cadence: 0, speed: 100 })).toBe("train");
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 120 })).toBe("train");
	});

	it("does NOT label walking when speed is too high (could be running)", () => {
		// 9 km/h with cadence 150 might be jogging — we don't have a
		// "running" mode, so refuse to label.
		expect(labelMinuteByHeuristic({ hr: 130, cadence: 150, speed: 9 })).toBeNull();
	});

	it("does NOT label walking when cadence is missing (passenger could match)", () => {
		// 5 km/h at cadence null — could be walking with watch off, could
		// be slow stop-and-go traffic. Skip.
		expect(labelMinuteByHeuristic({ hr: 100, cadence: null, speed: 5 })).toBeNull();
	});

	it("returns null for ambiguous mid-band observations", () => {
		// 10 km/h cadence 30 HR 100 — could be cycling, slow drive, fast
		// walk, escalator, whatever. No clean label.
		expect(labelMinuteByHeuristic({ hr: 100, cadence: 30, speed: 10 })).toBeNull();
	});

	it("returns null when there is no signal at all", () => {
		expect(labelMinuteByHeuristic({ hr: null, cadence: null, speed: null })).toBeNull();
	});
});

describe("aggregateModeStats", () => {
	// Per-mode summary statistics from an array of labeled minute samples.
	// Produces mean/std/sample_count per mode, plus per-modality
	// null-counts so application can decide whether HR-based scoring is
	// viable.

	it("groups samples by mode and computes per-mode means", () => {
		const samples: { mode: string; obs: MinuteObservation }[] = [
			{ mode: "walking", obs: { hr: 100, cadence: 110, speed: 5 } },
			{ mode: "walking", obs: { hr: 110, cadence: 120, speed: 5 } },
			{ mode: "walking", obs: { hr: 120, cadence: 100, speed: 5 } },
			{ mode: "cycling", obs: { hr: 130, cadence: 0, speed: 18 } },
			{ mode: "cycling", obs: { hr: 140, cadence: 0, speed: 20 } },
		];
		const stats = aggregateModeStats(samples);
		const walking = stats.find((s) => s.mode === "walking");
		expect(walking?.hrMean).toBeCloseTo(110, 1);
		expect(walking?.sampleCount).toBe(3);
		const cycling = stats.find((s) => s.mode === "cycling");
		expect(cycling?.hrMean).toBeCloseTo(135, 1);
		expect(cycling?.speedMean).toBeCloseTo(19, 1);
	});

	it("handles nullable modalities — null HRs are excluded from HR stats", () => {
		const samples = [
			{ mode: "walking", obs: { hr: 100, cadence: 110, speed: 5 } },
			{ mode: "walking", obs: { hr: null, cadence: 120, speed: 5 } },
			{ mode: "walking", obs: { hr: null, cadence: 100, speed: 5 } },
		];
		const stats = aggregateModeStats(samples);
		const walking = stats.find((s) => s.mode === "walking");
		expect(walking?.hrMean).toBeCloseTo(100, 1);
		expect(walking?.hrSampleCount).toBe(1);
		expect(walking?.sampleCount).toBe(3); // total samples for this mode
	});

	it("computes standard deviation", () => {
		const samples = [
			{ mode: "walking", obs: { hr: 100, cadence: 100, speed: 5 } },
			{ mode: "walking", obs: { hr: 120, cadence: 100, speed: 5 } },
		];
		const stats = aggregateModeStats(samples);
		const walking = stats.find((s) => s.mode === "walking");
		// Population std of [100, 120] around mean 110 = sqrt((100+100)/2) = 10
		expect(walking?.hrStd).toBeCloseTo(10, 1);
	});

	it("returns empty array when given no samples", () => {
		expect(aggregateModeStats([])).toEqual([]);
	});

	it("returns null hrMean when all HRs are null for that mode", () => {
		const samples = [
			{ mode: "stationary", obs: { hr: null, cadence: 0, speed: 0.3 } },
			{ mode: "stationary", obs: { hr: null, cadence: 0, speed: 0.4 } },
		];
		const stats = aggregateModeStats(samples);
		const stat = stats.find((s) => s.mode === "stationary");
		expect(stat?.hrMean).toBeNull();
		expect(stat?.hrStd).toBeNull();
		expect(stat?.sampleCount).toBe(2);
	});

	it("ignores samples with null speed (cannot be aggregated)", () => {
		const samples = [
			{ mode: "walking", obs: { hr: 100, cadence: 110, speed: 5 } },
			{ mode: "walking", obs: { hr: 110, cadence: 120, speed: null } },
		];
		const stats = aggregateModeStats(samples);
		const walking = stats.find((s) => s.mode === "walking");
		expect(walking?.speedMean).toBeCloseTo(5, 1);
		expect(walking?.sampleCount).toBe(2);
	});
});
