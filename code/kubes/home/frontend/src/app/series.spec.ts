import type { DeviceLatest, Measurement } from './measurement.model';
import { airSeries, climateSeries, toTrendPoints } from './series';

function reading(over: Partial<Measurement>): Measurement {
	return {
		ts: '2026-06-27T00:00:00.000Z',
		device: 'x',
		temp_c: null,
		humidity: null,
		co2_ppm: null,
		pm01: null,
		pm25: null,
		pm10: null,
		aqi_us: null,
		voc_ppb: null,
		battery: null,
		rssi: null,
		...over,
	};
}

function dev(device: string, airQuality: boolean, order: number): DeviceLatest {
	return {
		...reading({ device }),
		label: { name: device, airQuality, order, type: "test" },
		offset: {},
	};
}

describe('toTrendPoints', () => {
	it('drops null values and keeps valid points', () => {
		const rows = [
			reading({ ts: '2026-06-27T00:00:00.000Z', temp_c: 20 }),
			reading({ ts: '2026-06-27T01:00:00.000Z', temp_c: null }),
			reading({ ts: '2026-06-27T02:00:00.000Z', temp_c: 22 }),
		];
		const pts = toTrendPoints(rows, (m) => m.temp_c);
		expect(pts.map((p) => p.y)).toEqual([20, 22]);
	});

	it('drops points with an unparseable timestamp', () => {
		const rows = [reading({ ts: 'not-a-date', temp_c: 20 })];
		expect(toTrendPoints(rows, (m) => m.temp_c)).toEqual([]);
	});
});

describe('climateSeries', () => {
	it('builds one series per device, in order, with distinct colours', () => {
		const devices = [dev('airvisual', true, 0), dev('govee-A562', false, 1)];
		const history = {
			airvisual: [reading({ device: 'airvisual', temp_c: 25 })],
			'govee-A562': [reading({ device: 'govee-A562', temp_c: 24 })],
		};
		const s = climateSeries(devices, history, (m) => m.temp_c);
		expect(s.map((x) => x.label)).toEqual(['airvisual', 'govee-A562']);
		expect(s[0].points[0].y).toBe(25);
		expect(s[1].points[0].y).toBe(24);
		expect(s[0].color).not.toBe(s[1].color);
	});

	it('yields an empty points array for a device with no history', () => {
		const s = climateSeries([dev('govee-A562', false, 1)], {}, (m) => m.temp_c);
		expect(s[0].points).toEqual([]);
	});
});

describe('airSeries', () => {
	it('returns a single series from the air-quality device', () => {
		const devices = [dev('airvisual', true, 0), dev('govee-A562', false, 1)];
		const history = { airvisual: [reading({ device: 'airvisual', co2_ppm: 600 })] };
		const s = airSeries(devices, history, 'CO₂', 'red', (m) => m.co2_ppm);
		expect(s.length).toBe(1);
		expect(s[0].label).toBe('CO₂');
		expect(s[0].points[0].y).toBe(600);
	});

	it('returns nothing when there is no air-quality device', () => {
		const s = airSeries([dev('govee-A562', false, 1)], {}, 'CO₂', 'red', (m) => m.co2_ppm);
		expect(s).toEqual([]);
	});
});
