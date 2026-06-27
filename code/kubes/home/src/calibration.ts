// Per-device sensor-calibration offsets. Served as metadata (per device, in
// /api/devices) and applied in the client, so the correction can be toggled on
// and off without touching the stored data — which is always raw.
//
// Derived 2026-06-27 by xinutec-infra/mac-mini/sensor-calibrate.py from ~59
// co-located, steady points, anchored to the duplicate-collapsed *type*
// consensus (each sensor type — IQAir, H5075, H5103 — gets one vote, so the
// three identical H5075s can't out-vote the rest). Model: a single additive
// offset per device; blocked-CV model selection showed gain/curve terms overfit
// the narrow 24–26 °C range. See doc/calibration.md.

export interface Calibration {
	temp_c?: number;
	humidity?: number;
}

const OFFSETS: Record<string, Calibration> = {
	airvisual: { temp_c: 0.35 },
	"govee-A562": { temp_c: -0.4 },
	"govee-525D": { temp_c: -0.2 },
	"govee-B7AC": { temp_c: -0.39 },
	"govee-267F": { temp_c: 0.04 },
};

/** Calibration offsets for a device — empty if none. */
export function offsetFor(device: string): Calibration {
	return OFFSETS[device] ?? {};
}
