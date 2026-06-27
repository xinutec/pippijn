/** A single environmental reading as returned by the backend API. */
export interface Measurement {
	ts: string;
	device: string;
	temp_c: number | null;
	humidity: number | null;
	co2_ppm: number | null;
	pm01: number | null;
	pm25: number | null;
	pm10: number | null;
	aqi_us: number | null;
	voc_ppb: number | null;
	battery: number | null;
	rssi: number | null;
}

/** Display overlay for a device, as returned alongside its latest reading. */
export interface DeviceLabel {
	name: string;
	airQuality: boolean;
	order: number;
	type: string;
}

/** A device's most recent reading plus its display label (from `/api/devices`). */
export interface DeviceLatest extends Measurement {
	label: DeviceLabel;
	/** Per-device calibration offsets, applied client-side when calibration is on. */
	offset: { temp_c?: number; humidity?: number };
}

/** Distinct line colours for the per-room comparison charts, assigned by order. */
export const ROOM_COLORS: readonly string[] = [
	'#26a69a',
	'#ef6c00',
	'#5c6bc0',
	'#ec407a',
	'#66bb6a',
	'#8d6e63',
];

/** Selectable history windows for the time-series charts. */
export type RangeKey = '24h' | '7d' | '30d';

export interface RangeOption {
	key: RangeKey;
	label: string;
	hours: number;
}

export const RANGE_OPTIONS: readonly RangeOption[] = [
	{ key: '24h', label: '24 hours', hours: 24 },
	{ key: '7d', label: '7 days', hours: 24 * 7 },
	{ key: '30d', label: '30 days', hours: 24 * 30 },
];

export interface AqiBand {
	/** Inclusive lower bound of the US-AQI band. */
	min: number;
	/** Inclusive upper bound (Infinity for the open-ended top band). */
	max: number;
	label: string;
	/** CSS custom-property name carrying the band colour. */
	cssVar: string;
}

/** US-AQI bands per the EPA scale. */
export const AQI_BANDS: readonly AqiBand[] = [
	{ min: 0, max: 50, label: 'Good', cssVar: '--aqi-good' },
	{ min: 51, max: 100, label: 'Moderate', cssVar: '--aqi-moderate' },
	{ min: 101, max: 150, label: 'Unhealthy for Sensitive Groups', cssVar: '--aqi-usg' },
	{ min: 151, max: 200, label: 'Unhealthy', cssVar: '--aqi-unhealthy' },
	{ min: 201, max: 300, label: 'Very Unhealthy', cssVar: '--aqi-very-unhealthy' },
	{ min: 301, max: Number.POSITIVE_INFINITY, label: 'Hazardous', cssVar: '--aqi-hazardous' },
];

/** Returns the AQI band for a given index, or `null` when no value is known. */
export function aqiBand(aqi: number | null | undefined): AqiBand | null {
	if (aqi == null || aqi < 0) {
		return null;
	}
	return AQI_BANDS.find((b) => aqi >= b.min && aqi <= b.max) ?? null;
}

/**
 * VOC is reported as -1 (or null) when the sensor has no reading.
 * Returns a clean number, or `null` when unavailable.
 */
export function cleanVoc(voc: number | null | undefined): number | null {
	if (voc == null || voc < 0) {
		return null;
	}
	return voc;
}
