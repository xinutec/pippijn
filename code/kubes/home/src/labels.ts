// Read-time device overlay: maps a stored device id to its display label and
// role. Keyed by the STABLE device id (a sensor's room is never stored), so a
// unit can be relabelled or moved with a one-line edit here and no DB migration.
// An unmapped device falls back to showing its raw id, so a newly-added sensor
// appears on the dashboard immediately, just unnamed.

export interface DeviceLabel {
	/** Human name shown in the UI — a room, once the sensor is sited. */
	name: string;
	/** True for the whole-home air-quality sensor (CO₂/PM/AQI/VOC). */
	airQuality: boolean;
	/** UI sort order; lower sorts first. */
	order: number;
}

// The air-quality sensor first, then the four Govee climate sensors. Set each
// Govee `name` to its room once placed; until then it shows its device id.
const LABELS: Record<string, DeviceLabel> = {
	airvisual: { name: "IQAir", airQuality: true, order: 0 },
	"govee-A562": { name: "govee-A562", airQuality: false, order: 1 },
	"govee-525D": { name: "govee-525D", airQuality: false, order: 2 },
	"govee-B7AC": { name: "govee-B7AC", airQuality: false, order: 3 },
	"govee-267F": { name: "govee-267F", airQuality: false, order: 4 },
};

/** Label for a device id, falling back to the raw id for unmapped sensors. */
export function labelFor(device: string): DeviceLabel {
	return LABELS[device] ?? { name: device, airQuality: false, order: 99 };
}
