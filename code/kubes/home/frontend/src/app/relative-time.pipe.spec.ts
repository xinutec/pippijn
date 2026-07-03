import { RelativeTimePipe } from './relative-time.pipe';

describe('RelativeTimePipe', () => {
	const pipe = new RelativeTimePipe();
	const now = Date.parse('2026-07-03T12:00:00.000Z');
	const at = (iso: string) => pipe.transform(iso, now);

	it('handles missing and malformed input', () => {
		expect(pipe.transform(null, now)).toBe('never');
		expect(pipe.transform(undefined, now)).toBe('never');
		expect(pipe.transform('yesterday', now)).toBe('unknown');
	});

	it('scales through the units', () => {
		expect(at('2026-07-03T11:59:58.000Z')).toBe('just now');
		expect(at('2026-07-03T11:59:30.000Z')).toBe('30 s ago');
		expect(at('2026-07-03T11:55:00.000Z')).toBe('5 min ago');
		expect(at('2026-07-03T09:00:00.000Z')).toBe('3 h ago');
		expect(at('2026-06-30T12:00:00.000Z')).toBe('3 d ago');
	});

	it('counts against the supplied now, so a stale reading keeps aging', () => {
		const reading = '2026-07-03T11:00:00.000Z';
		expect(pipe.transform(reading, now)).toBe('1 h ago');
		expect(pipe.transform(reading, now + 2 * 3_600_000)).toBe('3 h ago');
	});
});
