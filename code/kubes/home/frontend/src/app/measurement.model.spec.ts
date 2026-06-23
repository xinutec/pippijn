import { aqiBand, cleanVoc } from './measurement.model';

describe('aqiBand', () => {
	it('classifies values into the correct US-AQI band', () => {
		expect(aqiBand(0)?.label).toBe('Good');
		expect(aqiBand(50)?.label).toBe('Good');
		expect(aqiBand(51)?.label).toBe('Moderate');
		expect(aqiBand(100)?.label).toBe('Moderate');
		expect(aqiBand(120)?.label).toBe('Unhealthy for Sensitive Groups');
		expect(aqiBand(175)?.label).toBe('Unhealthy');
		expect(aqiBand(250)?.label).toBe('Very Unhealthy');
		expect(aqiBand(400)?.label).toBe('Hazardous');
	});

	it('returns null for missing or sentinel values', () => {
		expect(aqiBand(null)).toBeNull();
		expect(aqiBand(undefined)).toBeNull();
		expect(aqiBand(-1)).toBeNull();
	});
});

describe('cleanVoc', () => {
	it('passes through valid readings', () => {
		expect(cleanVoc(0)).toBe(0);
		expect(cleanVoc(120)).toBe(120);
	});

	it('treats null and -1 as not available', () => {
		expect(cleanVoc(null)).toBeNull();
		expect(cleanVoc(undefined)).toBeNull();
		expect(cleanVoc(-1)).toBeNull();
	});
});
