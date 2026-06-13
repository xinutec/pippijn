import { describe, expect, it } from "vitest";
import type { GroundTruthMode, GroundTruthRow, ParsedBlessed } from "../src/eval/ground-truth.js";
import { decoderJourneys, groundTruthJourneys, scoreJourneys } from "../src/eval/journey-score.js";
import type { DecoderMinute } from "../src/eval/score-day.js";

/**
 * Journey-level scorer (`src/eval/journey-score.ts`) — the boundary-robust,
 * trip-structure cutover gate. These pin the two properties per-minute
 * scoring lacks: leg fidelity that survives edge slop, and trip-shape
 * regression detection — while keeping a genuinely wrong mode an honest miss.
 */

const T0 = 1_700_000_000;

function gtRow(startMin: number, endMin: number, mode: GroundTruthMode, line: string | null = null): GroundTruthRow {
	const blessed: ParsedBlessed = {
		mode,
		place: null,
		wayName: null,
		placeQualifier: null,
		trainFromTo: null,
		lineName: line,
	};
	return {
		windowText: `${startMin}–${endMin}`,
		startTs: T0 + startMin * 60,
		endTs: T0 + endMin * 60,
		blessedText: "(synthetic)",
		blessed,
		status: "correct",
		provenance: "user",
		statusText: "correct",
		correctVersionText: null,
	};
}

/** Decoder minutes for [startMin, endMin) of one mode (+ optional line). */
function dec(
	startMin: number,
	endMin: number,
	mode: DecoderMinute["mode"],
	line: string | null = null,
): DecoderMinute[] {
	const out: DecoderMinute[] = [];
	for (let m = startMin; m < endMin; m++) out.push({ ts: T0 + m * 60, mode, placeId: null, lineName: line });
	return out;
}

describe("groundTruthJourneys", () => {
	it("groups consecutive movement rows into one journey, split by a stay", () => {
		const rows = [
			gtRow(0, 10, "walking"),
			gtRow(10, 30, "train", "Jubilee Line"),
			gtRow(30, 40, "walking"),
			gtRow(40, 100, "stationary"), // a stay — breaks the journey
			gtRow(100, 110, "walking"),
			gtRow(110, 130, "bus", "38"),
		];
		const journeys = groundTruthJourneys(rows);
		expect(journeys).toHaveLength(2);
		expect(journeys[0].legs.map((l) => l.mode)).toEqual(["walking", "train", "walking"]);
		expect(journeys[1].legs.map((l) => l.mode)).toEqual(["walking", "bus"]);
	});
});

describe("decoderJourneys", () => {
	it("collapses per-minute runs into legs and drops non-movement", () => {
		const minutes = [...dec(0, 5, "walking"), ...dec(5, 15, "train", "Jubilee Line"), ...dec(15, 20, "stationary")];
		const journeys = decoderJourneys(minutes);
		expect(journeys).toHaveLength(1);
		expect(journeys[0].legs.map((l) => l.mode)).toEqual(["walking", "train"]);
	});
});

describe("scoreJourneys — leg fidelity (boundary robust)", () => {
	it("credits a leg whose decoder mode is offset by a few minutes", () => {
		// GT train 10:00–10:10; decoder train shifted to 10:02–10:12.
		const rows = [gtRow(0, 10, "train", "Victoria Line")];
		const decoder = dec(2, 12, "train", "Victoria Line");
		const score = scoreJourneys(rows, decoder);
		// 8 of 10 GT minutes are train (10:02–10:10) — dominant → leg matches,
		// where per-minute would only score 8/10.
		expect(score.legModeMatching).toBe(1);
		expect(score.legModeScorable).toBe(1);
		expect(score.legLineMatching).toBe(1);
	});

	it("keeps a genuinely wrong mode an honest miss (no fudge)", () => {
		// GT train 10:00–10:10; decoder mostly walking (the real failure mode).
		const rows = [gtRow(0, 10, "train", "Victoria Line")];
		const decoder = [...dec(0, 7, "walking"), ...dec(7, 10, "train", "Victoria Line")];
		const score = scoreJourneys(rows, decoder);
		expect(score.legModeMatching).toBe(0); // walking dominates → miss
		expect(score.legLineMatching).toBe(0); // line can't be credited on a missed mode
	});

	it("scores a transit line mismatch as a line miss but mode match", () => {
		const rows = [gtRow(0, 10, "train", "Victoria Line")];
		const decoder = dec(0, 10, "train", "Circle Line");
		const score = scoreJourneys(rows, decoder);
		expect(score.legModeMatching).toBe(1);
		expect(score.legLineScorable).toBe(1);
		expect(score.legLineMatching).toBe(0);
	});

	it("scores bus distinct from driving (the 06-12 case)", () => {
		const rows = [gtRow(0, 10, "bus", "38")];
		expect(scoreJourneys(rows, dec(0, 10, "bus", "38")).legModeMatching).toBe(1);
		expect(scoreJourneys(rows, dec(0, 10, "driving")).legModeMatching).toBe(0);
		expect(scoreJourneys(rows, dec(0, 10, "walking")).legModeMatching).toBe(0);
	});
});

describe("scoreJourneys — trip structure", () => {
	const rows = [gtRow(0, 5, "walking"), gtRow(5, 20, "train", "Jubilee Line"), gtRow(20, 25, "walking")];

	it("matches a journey reconstructed with the same mode sequence", () => {
		const decoder = [...dec(0, 5, "walking"), ...dec(5, 20, "train", "Jubilee Line"), ...dec(20, 25, "walking")];
		const score = scoreJourneys(rows, decoder);
		expect(score.journeysExpected).toBe(1);
		expect(score.journeysModeSequenceMatched).toBe(1);
	});

	it("fails the structure gate when the decoder drops a leg", () => {
		// Decoder omits the exit walk → shape [walk, train] ≠ [walk, train, walk].
		const decoder = [...dec(0, 5, "walking"), ...dec(5, 25, "train", "Jubilee Line")];
		const score = scoreJourneys(rows, decoder);
		expect(score.journeysModeSequenceMatched).toBe(0);
	});

	it("fails the structure gate when the decoder invents a leg", () => {
		// Decoder splits the train with a phantom driving leg in the middle.
		const decoder = [
			...dec(0, 5, "walking"),
			...dec(5, 12, "train", "Jubilee Line"),
			...dec(12, 14, "driving"),
			...dec(14, 20, "train", "Jubilee Line"),
			...dec(20, 25, "walking"),
		];
		const score = scoreJourneys(rows, decoder);
		expect(score.journeysModeSequenceMatched).toBe(0);
	});
});
