// Read-time device overlay: maps a stored device id to its display label and
// role. Keyed by the STABLE device id (a sensor's room is never stored), so a
// unit can be relabelled or moved with a one-line edit here and no DB migration.
// An unmapped device falls back to showing its raw id, so a newly-added sensor
// appears on the dashboard immediately, just unnamed.

export interface DeviceLabel {
	/** Human name shown in the UI — the device's own name (e.g. "IQAir"). */
	name: string;
	/**
	 * Physical location, once the sensor is sited. Orthogonal to the device id:
	 * moving a unit to another room is a one-line edit here (and its calibration
	 * offset travels with it), no DB migration. Optional — an unsited sensor has
	 * none and the UI falls back to its name/id.
	 */
	room?: string;
	/** True for the whole-home air-quality sensor (CO₂/PM/AQI/VOC). */
	airQuality: boolean;
	/** UI sort order; lower sorts first. */
	order: number;
	/** Hardware model — static per device (the BLE-reported model / device type). */
	type: string;
}

// The air-quality sensor first, then the four Govee climate sensors. Set each
// sensor's `room` once it's placed; until then the UI shows its name/device id.
const LABELS: Record<string, DeviceLabel> = {
	airvisual: {
		name: "IQAir",
		room: "Bedroom",
		airQuality: true,
		order: 0,
		type: "IQAir AirVisual Pro",
	},
	"govee-A562": {
		name: "govee-A562",
		room: "Living Room",
		airQuality: false,
		order: 1,
		type: "Govee H5075",
	},
	"govee-525D": {
		name: "govee-525D",
		room: "Kitchen",
		airQuality: false,
		order: 2,
		type: "Govee H5075",
	},
	"govee-B7AC": {
		name: "govee-B7AC",
		room: "Guestroom",
		airQuality: false,
		order: 3,
		type: "Govee H5075",
	},
	"govee-267F": { name: "govee-267F", airQuality: false, order: 4, type: "Govee H5103" },
};

/** Label for a device id, falling back to the raw id for unmapped sensors. */
export function labelFor(device: string): DeviceLabel {
	return LABELS[device] ?? { name: device, airQuality: false, order: 99, type: "Unknown" };
}

/** Attach a label to each latest-per-device row and order them for the UI. */
export function decorateDevices<T extends { device: string }>(
	rows: T[],
): (T & { label: DeviceLabel })[] {
	return rows
		.map((r) => ({ ...r, label: labelFor(r.device) }))
		.sort((a, b) => a.label.order - b.label.order);
}
