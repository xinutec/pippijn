import { describe, expect, it } from "vitest";
import { decideMonitoringCommand, type MonitoringMode } from "../src/routes/owntracks.js";

describe("decideMonitoringCommand", () => {
	// Owntracks "monitoring" modes:
	//   0 = Manual (user-initiated only — no automatic reporting)
	//   1 = Significant (~100m or movement-triggered, battery-efficient)
	//   2 = Move (continuous, every X seconds — high fidelity)
	//
	// Server-side rule: when the user is clearly in transit (high speed),
	// flip to Move so we get dense fixes during the journey. When sitting
	// still (low speed for sustained period), drop to Significant to save
	// battery. Mid-range stays at whatever was last set.
	//
	// Returns null when no command should be sent (either no change
	// warranted, or the desired mode equals the last-sent mode).

	it("requests Move mode when speed clearly in transit (> 30 km/h)", () => {
		expect(decideMonitoringCommand(60, null)).toBe(2);
		expect(decideMonitoringCommand(100, 1)).toBe(2);
	});

	it("requests Significant mode when speed near zero (< 5 km/h)", () => {
		expect(decideMonitoringCommand(0, null)).toBe(1);
		expect(decideMonitoringCommand(2, 2)).toBe(1);
	});

	it("returns null when the desired mode equals the last-sent mode", () => {
		// Don't spam the same command on every fix.
		expect(decideMonitoringCommand(60, 2)).toBeNull();
		expect(decideMonitoringCommand(0, 1)).toBeNull();
	});

	it("returns null for mid-range speeds (no clear signal either way)", () => {
		// 5-30 km/h covers walking/cycling/slow drive — the right mode
		// depends on context we don't have here, so don't override.
		expect(decideMonitoringCommand(10, null)).toBeNull();
		expect(decideMonitoringCommand(20, 1)).toBeNull();
		expect(decideMonitoringCommand(25, 2)).toBeNull();
	});

	it("treats threshold values consistently (< is strict)", () => {
		// exactly 5 km/h → not slow enough to be "stopped"
		expect(decideMonitoringCommand(5, null)).toBeNull();
		// exactly 30 km/h → not fast enough to be "in transit"
		expect(decideMonitoringCommand(30, null)).toBeNull();
	});

	it("type-narrows the return to a valid monitoring mode", () => {
		const r = decideMonitoringCommand(60, null);
		if (r !== null) {
			const ok: MonitoringMode = r;
			expect([0, 1, 2]).toContain(ok);
		}
	});
});
