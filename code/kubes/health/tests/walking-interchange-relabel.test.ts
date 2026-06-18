/**
 * relabelWalkingInterchanges — a short `walking` segment between two train
 * legs that share a station is the platform-to-platform interchange (a line
 * change), not a street walk. GPS resurfacing mid-change otherwise names it
 * after the nearest road (the 2026-06-16 Baker St Met→Jubilee change,
 * mislabelled "Allsop Place"). Only the wayName is rewritten.
 */

import { describe, expect, it } from "vitest";
import { relabelWalkingInterchanges } from "../src/geo/passes/rail-absorbers.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

function seg(
	mode: EnrichedSegment["mode"],
	startMin: number,
	endMin: number,
	extra: Partial<EnrichedSegment> = {},
): EnrichedSegment {
	return {
		startTs: startMin * 60,
		endTs: endMin * 60,
		mode,
		refinedMode: mode,
		confidence: 0.9,
		confidenceMargin: 5,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 10,
		...extra,
	};
}

const ways = (segs: EnrichedSegment[]): (string | undefined)[] => segs.map((s) => s.wayName);

describe("relabelWalkingInterchanges", () => {
	it("relabels a short walk between two trains that share a station", () => {
		const segs = [
			seg("train", 0, 9, { wayName: "Wembley Park → Baker Street" }),
			seg("walking", 9, 11, { wayName: "Allsop Place" }),
			seg("train", 11, 15, { wayName: "Baker Street → Green Park · Jubilee Line" }),
		];
		const out = relabelWalkingInterchanges(segs);
		expect(ways(out)).toEqual([
			"Wembley Park → Baker Street",
			"Baker Street (interchange)",
			"Baker Street → Green Park · Jubilee Line",
		]);
	});

	it("records the line change in the reason when both legs are line-named", () => {
		const segs = [
			seg("train", 0, 9, { wayName: "A → King's Cross · Victoria Line" }),
			seg("walking", 9, 11, { wayName: "Pentonville Road" }),
			seg("train", 11, 15, { wayName: "King's Cross → B · Metropolitan Line" }),
		];
		const out = relabelWalkingInterchanges(segs);
		expect(out[1].refinedReason).toBe("walking interchange at King's Cross (Victoria Line → Metropolitan Line)");
	});

	it("does NOT relabel when the two trains do not share a station", () => {
		const segs = [
			seg("train", 0, 9, { wayName: "A → Baker Street" }),
			seg("walking", 9, 11, { wayName: "Marylebone Road" }),
			seg("train", 11, 15, { wayName: "Bond Street → C" }), // boards a different station
		];
		const out = relabelWalkingInterchanges(segs);
		expect(out[1].wayName).toBe("Marylebone Road");
	});

	it("does NOT relabel a walk too long to be a platform change", () => {
		const segs = [
			seg("train", 0, 9, { wayName: "A → Baker Street" }),
			seg("walking", 9, 20, { wayName: "Marylebone High Street" }), // 11 min — out of the station
			seg("train", 20, 30, { wayName: "Baker Street → C" }),
		];
		const out = relabelWalkingInterchanges(segs);
		expect(out[1].wayName).toBe("Marylebone High Street");
	});

	it("does NOT relabel a walk not bookended by two trains", () => {
		const segs = [
			seg("train", 0, 9, { wayName: "A → Baker Street" }),
			seg("walking", 9, 11, { wayName: "Allsop Place" }),
			seg("stationary", 11, 30, { place: "Home" }),
		];
		const out = relabelWalkingInterchanges(segs);
		expect(out[1].wayName).toBe("Allsop Place");
	});
});
