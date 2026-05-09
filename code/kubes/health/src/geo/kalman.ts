/**
 * GPS Kalman filter for position + velocity estimation.
 *
 * State vector: [lat, lon, vlat, vlon] (degrees, degrees, deg/s, deg/s)
 * Measurement: [lat, lon] with accuracy in meters
 *
 * The filter smooths noisy GPS data and produces reliable speed estimates.
 * When moving fast (e.g. train), it trusts velocity predictions over
 * individual GPS fixes, naturally rejecting sideways jumps.
 */

// Earth radius in meters (for converting degrees <-> meters)
const R_EARTH = 6371000;

// Convert meters to degrees latitude
function metersToDegreesLat(m: number): number {
	return m / (R_EARTH * (Math.PI / 180));
}

// Convert meters to degrees longitude at a given latitude
function metersToDegreesLon(m: number, lat: number): number {
	return m / (R_EARTH * Math.cos(lat * (Math.PI / 180)) * (Math.PI / 180));
}

// Convert degrees to meters (haversine-based distance)
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const dLat = (lat2 - lat1) * (Math.PI / 180);
	const dLon = (lon2 - lon1) * (Math.PI / 180);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
	return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface GpsPoint {
	ts: number; // unix timestamp (seconds)
	lat: number;
	lon: number;
	accuracy: number | null; // meters
}

export interface FilteredPoint {
	ts: number;
	lat: number;
	lon: number;
	speed_kmh: number;
	bearing: number; // degrees, 0 = north, 90 = east
}

/**
 * 2D Kalman filter state.
 * We run two independent 1D filters (lat and lon) each with position + velocity.
 * This is simpler than a full 4D filter and works well for GPS.
 */
interface KalmanState1D {
	x: number; // position (degrees)
	v: number; // velocity (degrees/s)
	px: number; // position variance
	pv: number; // velocity variance
	pxv: number; // position-velocity covariance
}

function predict1D(s: KalmanState1D, dt: number, processNoise: number): KalmanState1D {
	// State prediction: x += v * dt
	const x = s.x + s.v * dt;
	const v = s.v;

	// Covariance prediction
	const px = s.px + 2 * dt * s.pxv + dt * dt * s.pv + (processNoise * dt * dt * dt) / 3;
	const pv = s.pv + processNoise * dt;
	const pxv = s.pxv + dt * s.pv + (processNoise * dt * dt) / 2;

	return { x, v, px, pv, pxv };
}

function update1D(s: KalmanState1D, measurement: number, measurementVariance: number): KalmanState1D {
	// Innovation
	const y = measurement - s.x;
	const sy = s.px + measurementVariance;

	// Kalman gains
	const kx = s.px / sy;
	const kv = s.pxv / sy;

	// State update
	const x = s.x + kx * y;
	const v = s.v + kv * y;

	// Covariance update
	const px = s.px - kx * s.px;
	const pv = s.pv - kv * s.pxv;
	const pxv = s.pxv - kx * s.pxv;

	return { x, v, px, pv, pxv };
}

/**
 * Process noise controls how much the filter expects velocity to change.
 * Higher = more responsive to acceleration (walking, driving).
 * Lower = smoother (train at constant speed).
 *
 * We use adaptive process noise: scale it with current estimated speed.
 * At high speed, we expect less lateral acceleration (train), so reduce noise.
 * At low speed, allow more variation (walking, turning corners).
 */
function adaptiveProcessNoise(speedDegPerSec: number, baseLat: number): number {
	const speedMs = speedDegPerSec * R_EARTH * (Math.PI / 180);
	const speedKmh = speedMs * 3.6;

	if (speedKmh > 80) {
		// High speed (train/plane): very smooth, trust velocity
		return 0.1;
	}
	if (speedKmh > 30) {
		// Driving: moderate smoothing
		return 0.5;
	}
	if (speedKmh > 7) {
		// Cycling: moderate
		return 1.0;
	}
	// Walking/stationary: responsive
	return 2.0;
}

export function filterGpsTrack(points: GpsPoint[]): FilteredPoint[] {
	if (points.length === 0) return [];
	if (points.length === 1) {
		return [{ ts: points[0].ts, lat: points[0].lat, lon: points[0].lon, speed_kmh: 0, bearing: 0 }];
	}

	// Default accuracy if not provided
	const defaultAccuracy = 20; // meters

	// Initialize state from first point
	const accM = points[0].accuracy ?? defaultAccuracy;
	const initVarianceLat = metersToDegreesLat(accM) ** 2;
	const initVarianceLon = metersToDegreesLon(accM, points[0].lat) ** 2;

	let stateLat: KalmanState1D = {
		x: points[0].lat,
		v: 0,
		px: initVarianceLat,
		pv: initVarianceLat, // initially uncertain about velocity
		pxv: 0,
	};

	let stateLon: KalmanState1D = {
		x: points[0].lon,
		v: 0,
		px: initVarianceLon,
		pv: initVarianceLon,
		pxv: 0,
	};

	const result: FilteredPoint[] = [
		{ ts: points[0].ts, lat: points[0].lat, lon: points[0].lon, speed_kmh: 0, bearing: 0 },
	];

	for (let i = 1; i < points.length; i++) {
		const p = points[i];
		const dt = p.ts - points[i - 1].ts;

		if (dt <= 0) continue; // skip duplicate timestamps
		if (dt > 3600) {
			// Gap > 1 hour: reset filter state
			const acc = p.accuracy ?? defaultAccuracy;
			const vLat = metersToDegreesLat(acc) ** 2;
			const vLon = metersToDegreesLon(acc, p.lat) ** 2;
			stateLat = { x: p.lat, v: 0, px: vLat, pv: vLat, pxv: 0 };
			stateLon = { x: p.lon, v: 0, px: vLon, pv: vLon, pxv: 0 };
			result.push({ ts: p.ts, lat: p.lat, lon: p.lon, speed_kmh: 0, bearing: 0 });
			continue;
		}

		// Adaptive process noise based on current speed estimate
		const currentSpeed = Math.sqrt(stateLat.v ** 2 + stateLon.v ** 2);
		const qLat = adaptiveProcessNoise(Math.abs(stateLat.v), stateLat.x);
		const qLon = adaptiveProcessNoise(Math.abs(stateLon.v), stateLat.x);

		// Scale process noise to degrees
		const qLatDeg = metersToDegreesLat(qLat) ** 2;
		const qLonDeg = metersToDegreesLon(qLon, stateLat.x) ** 2;

		// Predict
		stateLat = predict1D(stateLat, dt, qLatDeg);
		stateLon = predict1D(stateLon, dt, qLonDeg);

		// Measurement noise from GPS accuracy
		const accM = p.accuracy ?? defaultAccuracy;
		const rLat = metersToDegreesLat(accM) ** 2;
		const rLon = metersToDegreesLon(accM, p.lat) ** 2;

		// Update
		stateLat = update1D(stateLat, p.lat, rLat);
		stateLon = update1D(stateLon, p.lon, rLon);

		// Calculate speed in km/h from velocity state
		const vLatMs = stateLat.v * R_EARTH * (Math.PI / 180);
		const vLonMs = stateLon.v * R_EARTH * Math.cos(stateLat.x * (Math.PI / 180)) * (Math.PI / 180);
		const speedMs = Math.sqrt(vLatMs ** 2 + vLonMs ** 2);
		const speedKmh = speedMs * 3.6;

		// Bearing from velocity
		const bearing = (Math.atan2(vLonMs, vLatMs) * (180 / Math.PI) + 360) % 360;

		result.push({
			ts: p.ts,
			lat: stateLat.x,
			lon: stateLon.x,
			speed_kmh: Math.round(speedKmh * 10) / 10,
			bearing: Math.round(bearing),
		});
	}

	return result;
}

/**
 * Classify transport mode from speed.
 */
export function classifyMode(speedKmh: number): "stationary" | "walking" | "cycling" | "driving" | "transit" {
	if (speedKmh < 2) return "stationary";
	if (speedKmh < 7) return "walking";
	if (speedKmh < 30) return "cycling";
	if (speedKmh < 120) return "driving";
	return "transit";
}
