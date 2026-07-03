// Per-device sensor-calibration offsets. Served as metadata (per device, in
// /api/devices) and applied in the client, so the correction can be toggled on
// and off without touching the stored data — which is always raw.
//
// Re-derived 2026-07-03 by xinutec-infra/mac-mini/sensor-calibrate.py from the
// past 24 h of co-located, steady points, anchored to the duplicate-collapsed
// *type* consensus (each sensor type — IQAir, H5075, H5103 — gets one vote, so
// the three identical H5075s can't out-vote the rest). Model: a single additive
// offset per device; blocked-CV model selection still showed gain/curve terms
// overfit the narrow (~22–23 °C) range. See doc/calibration.md.
//
// The sensors have since self-recalibrated into near-agreement: raw, they now
// concur to ~0.07 °C (they used to differ by ~0.8 °C), so the corrections are
// all sub-0.1 °C. The earlier ±0.4 °C offsets had drifted out from under the
// hardware and were widening the spread rather than closing it.

export interface Calibration {
	temp_c?: number;
	humidity?: number;
}

const OFFSETS: Record<string, Calibration> = {
	airvisual: { temp_c: -0.02 },
	"govee-A562": { temp_c: -0.05 },
	"govee-525D": { temp_c: -0.01 },
	"govee-B7AC": { temp_c: -0.05 },
	"govee-267F": { temp_c: 0.06 },
};

/** Calibration offsets for a device — empty if none. */
export function offsetFor(device: string): Calibration {
	return OFFSETS[device] ?? {};
}
