import { type DeviceLatest, type Measurement, ROOM_COLORS } from './measurement.model';
import type { ChartSeries, TrendPoint } from './trend-chart/trend-chart';

/** Project history rows onto chart points, dropping null values and bad timestamps. */
export function toTrendPoints(
	rows: Measurement[],
	pick: (m: Measurement) => number | null,
): TrendPoint[] {
	const out: TrendPoint[] = [];
	for (const m of rows) {
		const y = pick(m);
		if (y == null) {
			continue;
		}
		const x = new Date(m.ts).getTime();
		if (!Number.isNaN(x)) {
			out.push({ x, y });
		}
	}
	return out;
}

/** One coloured line per device (in the given order) for a climate metric. */
export function climateSeries(
	devices: DeviceLatest[],
	history: Record<string, Measurement[]>,
	pick: (m: Measurement) => number | null,
	offsetOf: (d: DeviceLatest) => number = () => 0,
): ChartSeries[] {
	return devices.map((d, i) => {
		const off = offsetOf(d);
		return {
			label: d.label.room ?? d.label.name,
			color: ROOM_COLORS[i % ROOM_COLORS.length],
			points: toTrendPoints(history[d.device] ?? [], pick).map((p) => ({ x: p.x, y: p.y + off })),
		};
	});
}

/** A single line from the air-quality device, or none if there isn't one. */
export function airSeries(
	devices: DeviceLatest[],
	history: Record<string, Measurement[]>,
	label: string,
	color: string,
	pick: (m: Measurement) => number | null,
): ChartSeries[] {
	const air = devices.find((d) => d.label.airQuality);
	if (!air) {
		return [];
	}
	return [{ label, color, points: toTrendPoints(history[air.device] ?? [], pick) }];
}
