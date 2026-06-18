import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/enriched-segment.js";
import { repairVehicleHandoff } from "../src/geo/passes/repair-handoff.js";
import type { TransportMode } from "../src/geo/segments.js";

let t = 0;
function seg(mode: TransportMode, opts: { wayName?: string; durS?: number; gapS?: number } = {}): EnrichedSegment {
	t += opts.gapS ?? 0;
	const s: EnrichedSegment = {
		startTs: t,
		endTs: t + (opts.durS ?? 600),
		mode,
		confidence: 1,
		confidenceMargin: 10,
		avgSpeed: 20,
		maxSpeed: 40,
		linearity: 0.8,
		pointCount: 10,
		...(opts.wayName ? { wayName: opts.wayName } : {}),
	};
	t = s.endTs;
	return s;
}

describe("repairVehicleHandoff", () => {
	it("absorbs a driving leg flush against an identified tube into the train (2026-06-18)", () => {
		t = 0;
		const driving = seg("driving", { wayName: "Euston Underpass", durS: 600 });
		const train = seg("train", { wayName: "Euston Square → Wembley Park · Metropolitan Line", durS: 300 });
		const out = repairVehicleHandoff([seg("walking"), driving, train, seg("walking", { gapS: 1 })]);
		// driving + train collapse to one train spanning both.
		const trains = out.filter((s) => s.mode === "train");
		expect(trains).toHaveLength(1);
		expect(trains[0].startTs).toBe(driving.startTs);
		expect(trains[0].endTs).toBe(train.endTs);
		expect(trains[0].wayName).toContain("Euston Square → Wembley Park");
		expect(out.filter((s) => s.mode === "driving")).toHaveLength(0);
	});

	it("does NOT touch a driving→train separated by a gap (real park-and-ride / alighting)", () => {
		t = 0;
		const out = repairVehicleHandoff([
			seg("driving", { durS: 600 }),
			seg("train", { wayName: "A → B · L", durS: 300, gapS: 600 }),
		]);
		expect(out.filter((s) => s.mode === "driving")).toHaveLength(1);
		expect(out.filter((s) => s.mode === "train")).toHaveLength(1);
	});

	it("does NOT touch a train→train interchange (same mode)", () => {
		t = 0;
		const out = repairVehicleHandoff([
			seg("train", { wayName: "A → B · Jubilee Line", durS: 600 }),
			seg("train", { wayName: "B → C · Metropolitan Line", durS: 600 }),
		]);
		expect(out.filter((s) => s.mode === "train")).toHaveLength(2);
	});

	it("does NOT absorb into an unidentified train (no board→alight wayName)", () => {
		t = 0;
		const out = repairVehicleHandoff([seg("driving"), seg("train", { wayName: "on subway" })]);
		// No resolved journey to absorb into — leave the (flagged) handoff alone.
		expect(out.filter((s) => s.mode === "driving")).toHaveLength(1);
	});

	it("collapses driving→train→driving into one train", () => {
		t = 0;
		const out = repairVehicleHandoff([
			seg("driving", { durS: 300 }),
			seg("train", { wayName: "A → B · L", durS: 600 }),
			seg("driving", { durS: 300 }),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("train");
	});
});
