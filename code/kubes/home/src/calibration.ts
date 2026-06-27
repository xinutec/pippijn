// Per-device sensor-calibration offsets, ADDED to the raw reading on read — the
// DB stays raw, so re-calibrating is a one-line edit here with no data migration.
//
// Derived 2026-06-27 by xinutec-infra/mac-mini/sensor-calibrate.py from ~59
// co-located, steady points, anchored to the duplicate-collapsed *type*
// consensus (each sensor type — IQAir, H5075, H5103 — gets one vote, so the
// three identical H5075s can't out-vote the rest). Model: a single additive
// offset per device; blocked-CV model selection showed gain/curve terms overfit
// the narrow 24–26 °C range. Re-run the script with a wider (seasonal) range to
// revisit whether a slope is ever warranted.

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

interface Reading {
	device: string;
	temp_c: number | null;
	humidity: number | null;
}

/** Apply a device's calibration offsets to a reading; raw values stay in the DB. */
export function calibrate<T extends Reading>(row: T): T {
	const c = OFFSETS[row.device];
	if (!c) {
		return row;
	}
	return {
		...row,
		temp_c: row.temp_c != null && c.temp_c != null ? row.temp_c + c.temp_c : row.temp_c,
		humidity: row.humidity != null && c.humidity != null ? row.humidity + c.humidity : row.humidity,
	};
}
