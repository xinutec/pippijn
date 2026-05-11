import { describe, expect, it } from "vitest";
import {
	aggregateModeStats,
	correctModeBySignature,
	labelMinuteByHeuristic,
	type MinuteObservation,
	type ModeStats,
	scoreModeLogLikelihood,
} from "../src/geo/mode-biometrics.js";

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
		// Fastest scheduled high-speed rail: TGV 320 km/h, Shinkansen 285.
		// Up to ~330 km/h is still rail.
		expect(labelMinuteByHeuristic({ hr: 75, cadence: 0, speed: 250 })).toBe("train");
	});

	it("labels cruise-speed zero-cadence as plane", () => {
		// Commercial jet cruise: 700-900 km/h. Unambiguous vs every other
		// mode — high-speed trains top out around 320 km/h, so > 500 km/h
		// is definitely a plane.
		expect(labelMinuteByHeuristic({ hr: 72, cadence: 0, speed: 800 })).toBe("plane");
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 700 })).toBe("plane");
		expect(labelMinuteByHeuristic({ hr: 90, cadence: 0, speed: 850 })).toBe("plane");
	});

	it("does NOT label transition-zone speeds (between high-speed rail and plane)", () => {
		// 350-500 km/h is climb-out / descent / fast turboprop — ambiguous.
		// Skip rather than corrupt either signature.
		expect(labelMinuteByHeuristic({ hr: 75, cadence: 0, speed: 400 })).toBeNull();
		expect(labelMinuteByHeuristic({ hr: 80, cadence: 0, speed: 450 })).toBeNull();
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

// Mined from pippijn's 2-year history (see commit message): close-to-real
// signatures used in scoring + correction tests. The walking/driving HR
// gap (108 vs 75) is exactly the signal we want the corrector to use.
const PIPPIJN_STATS: ModeStats[] = [
	{
		mode: "stationary",
		hrMean: 68.5,
		hrStd: 12.3,
		hrSampleCount: 50000,
		cadenceMean: 0,
		cadenceStd: 0.4,
		cadenceSampleCount: 50000,
		speedMean: 0.3,
		speedStd: 0.3,
		speedSampleCount: 50000,
		sampleCount: 51693,
	},
	{
		mode: "walking",
		hrMean: 108,
		hrStd: 14,
		hrSampleCount: 9000,
		cadenceMean: 107,
		cadenceStd: 11,
		cadenceSampleCount: 10000,
		speedMean: 5.1,
		speedStd: 1.1,
		speedSampleCount: 10000,
		sampleCount: 10034,
	},
	{
		mode: "driving",
		hrMean: 75,
		hrStd: 8,
		hrSampleCount: 4000,
		cadenceMean: 0,
		cadenceStd: 0.5,
		cadenceSampleCount: 4274,
		speedMean: 52,
		speedStd: 15,
		speedSampleCount: 4274,
		sampleCount: 4274,
	},
	{
		mode: "cycling",
		hrMean: 107,
		hrStd: 6,
		hrSampleCount: 60,
		cadenceMean: 0,
		cadenceStd: 0.8,
		cadenceSampleCount: 60,
		speedMean: 17.5,
		speedStd: 3.3,
		speedSampleCount: 60,
		sampleCount: 60,
	},
	{
		mode: "train",
		hrMean: 74,
		hrStd: 9,
		hrSampleCount: 4000,
		cadenceMean: 0,
		cadenceStd: 0.4,
		cadenceSampleCount: 4052,
		speedMean: 100, // realistic train cruise; ignore the airplane-skewed real value
		speedStd: 30,
		speedSampleCount: 4052,
		sampleCount: 4052,
	},
];

describe("scoreModeLogLikelihood", () => {
	const walking = PIPPIJN_STATS.find((s) => s.mode === "walking")!;
	const driving = PIPPIJN_STATS.find((s) => s.mode === "driving")!;

	it("scores a perfect walking observation high under walking", () => {
		const score = scoreModeLogLikelihood({ hr: 108, cadence: 107, speed: 5.1 }, walking);
		// Three z-scores all zero → log-lik = 0 (the max under Gaussian).
		expect(score).toBeCloseTo(0, 1);
	});

	it("scores a perfect walking observation low under driving", () => {
		// HR 108 is 4σ above driving's 75; speed 5 is 3σ below driving's 52.
		const score = scoreModeLogLikelihood({ hr: 108, cadence: 107, speed: 5.1 }, driving);
		// Significantly negative — driving doesn't explain this observation.
		expect(score).toBeLessThan(-10);
	});

	it("scores an observation higher under the correct mode", () => {
		const obs = { hr: 105, cadence: 105, speed: 5 };
		const wScore = scoreModeLogLikelihood(obs, walking);
		const dScore = scoreModeLogLikelihood(obs, driving);
		expect(wScore).toBeGreaterThan(dScore);
	});

	it("handles null observations gracefully (drops the modality)", () => {
		// HR missing → just cadence + speed contribute.
		const score = scoreModeLogLikelihood({ hr: null, cadence: 107, speed: 5.1 }, walking);
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeCloseTo(0, 1); // cadence+speed at mean
	});

	it("returns -Infinity when modeStat has all-null modalities (unusable)", () => {
		const empty: ModeStats = {
			mode: "x",
			hrMean: null,
			hrStd: null,
			hrSampleCount: 0,
			cadenceMean: null,
			cadenceStd: null,
			cadenceSampleCount: 0,
			speedMean: null,
			speedStd: null,
			speedSampleCount: 0,
			sampleCount: 0,
		};
		expect(scoreModeLogLikelihood({ hr: 100, cadence: 100, speed: 5 }, empty)).toBe(-Infinity);
	});

	it("returns the same score regardless of std-zero modalities (skipped)", () => {
		// std=0 would be /0; should be treated as "no info" for that modality.
		const degenerate: ModeStats = {
			mode: "x",
			hrMean: 80,
			hrStd: 0,
			hrSampleCount: 1,
			cadenceMean: 0,
			cadenceStd: 0.4,
			cadenceSampleCount: 100,
			speedMean: 5,
			speedStd: 1,
			speedSampleCount: 100,
			sampleCount: 100,
		};
		const score = scoreModeLogLikelihood({ hr: 80, cadence: 0, speed: 5 }, degenerate);
		expect(Number.isFinite(score)).toBe(true);
	});
});

describe("correctModeBySignature", () => {
	// The bug we're fixing: a walking segment near Bridge Road got
	// classified as "driving 6.3 km/h". HR ~110, cadence ~100, speed ~6.
	// Under driving's signature this fits terribly (HR way too high,
	// speed way too low). Under walking it fits well.

	it("fixes walking-mislabeled-as-driving (HR + cadence dispositive)", () => {
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.2, obsHr: 110, obsCadence: 100, obsSpeed: 6 },
			PIPPIJN_STATS,
		);
		expect(r.mode).toBe("walking");
		expect(r.changed).toBe(true);
	});

	it("fixes cycling-mislabeled-as-driving (HR + speed dispositive)", () => {
		// 18 km/h with no steps and HR 130 — cycling, not slow driving.
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.5, obsHr: 130, obsCadence: 0, obsSpeed: 18 },
			PIPPIJN_STATS,
		);
		expect(r.mode).toBe("cycling");
		expect(r.changed).toBe(true);
	});

	it("leaves a clear driving segment alone (high speed, low HR, no steps)", () => {
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 5, obsHr: 75, obsCadence: 0, obsSpeed: 60 },
			PIPPIJN_STATS,
		);
		expect(r.mode).toBe("driving");
		expect(r.changed).toBe(false);
	});

	it("does NOT relabel when original confidence is high (margin > 3)", () => {
		// High-margin classifications are trusted even when biometrics look
		// a little off — could be a stressed driver (HR 110 in traffic).
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 4, obsHr: 110, obsCadence: 0, obsSpeed: 30 },
			PIPPIJN_STATS,
		);
		expect(r.mode).toBe("driving");
		expect(r.changed).toBe(false);
	});

	it("does NOT relabel when biometrics are completely missing", () => {
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1, obsHr: null, obsCadence: null, obsSpeed: 25 },
			PIPPIJN_STATS,
		);
		// Speed alone is too weak a signal to override.
		expect(r.changed).toBe(false);
	});

	it("does NOT relabel when the new mode is only marginally better", () => {
		// A small log-likelihood gap shouldn't flip the label. Only big
		// differences (>= LL_THRESHOLD) trigger a correction.
		const r = correctModeBySignature(
			{ mode: "walking", confidenceMargin: 1.2, obsHr: 100, obsCadence: 100, obsSpeed: 4.5 },
			PIPPIJN_STATS,
		);
		// Slight HR deviation but everything still walking-like.
		expect(r.mode).toBe("walking");
		expect(r.changed).toBe(false);
	});

	it("returns no change when modeStats are empty (cold-start user)", () => {
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1, obsHr: 110, obsCadence: 100, obsSpeed: 5 },
			[],
		);
		expect(r.mode).toBe("driving");
		expect(r.changed).toBe(false);
	});

	it("returns no change when current mode is stationary (stays not corrected)", () => {
		// Stationary segments are detected by clustering, not by mode score.
		// Biometric correction doesn't apply.
		const r = correctModeBySignature(
			{ mode: "stationary", confidenceMargin: 100, obsHr: 75, obsCadence: 0, obsSpeed: 0.3 },
			PIPPIJN_STATS,
		);
		expect(r.changed).toBe(false);
	});

	// Sit-mode pairs (driving / train / plane) are biometrically
	// indistinguishable — same low HR, same zero cadence. Only speed
	// differs, and speed is what the GPS classifier + refineMode already
	// used (with OSM road/rail data). Letting biometric correction flip
	// between them adds noise on top of the genuine signal. Real bug:
	// motorway driving at 94 km/h got flipped to train because the user's
	// driving stats are dominated by 52 km/h city driving, making 94 km/h
	// look more train-like by speed alone.

	it("does NOT flip driving to train on a fast motorway stretch", () => {
		// 94 km/h on a motorway: clearly driving but speed is closer to
		// the train signature's mean. Biometric correction must not flip.
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.5, obsHr: 75, obsCadence: 0, obsSpeed: 94 },
			PIPPIJN_STATS,
		);
		expect(r.mode).toBe("driving");
		expect(r.changed).toBe(false);
	});

	it("does NOT flip train to driving on a slow stretch", () => {
		// 60 km/h on a train: could be a slowdown approaching a station,
		// or a regional service. Speed is closer to driving signature but
		// biometrics can't tell driving from train. Keep as classified.
		const r = correctModeBySignature(
			{ mode: "train", confidenceMargin: 1.5, obsHr: 75, obsCadence: 0, obsSpeed: 60 },
			PIPPIJN_STATS,
		);
		expect(r.mode).toBe("train");
		expect(r.changed).toBe(false);
	});

	it("does NOT flip plane to train or driving on a slow descent", () => {
		// Plane on final approach at 350 km/h: speed below typical plane
		// cruise (850) but well above train (119) and driving (52). The
		// biometrics (low HR, no cadence) match all three sit-modes
		// equally. Don't flip.
		const r = correctModeBySignature(
			{ mode: "plane", confidenceMargin: 1.5, obsHr: 75, obsCadence: 0, obsSpeed: 350 },
			PIPPIJN_STATS,
		);
		expect(r.mode).toBe("plane");
		expect(r.changed).toBe(false);
	});

	it("STILL flips driving to walking when biometrics genuinely disagree", () => {
		// Re-verify that legitimate cross-class corrections still work.
		// Walking and driving are biometrically distinguishable (cadence
		// + HR), so this flip should fire — regression check.
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.2, obsHr: 110, obsCadence: 100, obsSpeed: 6 },
			PIPPIJN_STATS,
		);
		expect(r.mode).toBe("walking");
		expect(r.changed).toBe(true);
	});

	it("STILL flips driving to cycling when HR + speed match cycling", () => {
		// Regression check on the other cross-class case.
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.5, obsHr: 130, obsCadence: 0, obsSpeed: 18 },
			PIPPIJN_STATS,
		);
		expect(r.mode).toBe("cycling");
		expect(r.changed).toBe(true);
	});
});
