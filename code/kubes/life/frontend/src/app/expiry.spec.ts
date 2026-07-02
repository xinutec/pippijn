import { describe, expect, it } from 'vitest';

import { expiryInfo } from './expiry';

// Fixed "today" for determinism.
const TODAY = new Date('2026-07-02T10:30:00Z');

describe('expiryInfo', () => {
  it('flags expired items with how long ago', () => {
    expect(expiryInfo('2026-06-29', TODAY)).toEqual({ label: 'expired 3d ago', cls: 'expired' });
    expect(expiryInfo('2026-07-01', TODAY)).toEqual({ label: 'expired 1d ago', cls: 'expired' });
  });

  it('flags today and the next few days as urgent', () => {
    expect(expiryInfo('2026-07-02', TODAY)).toEqual({ label: 'expires today', cls: 'soon' });
    expect(expiryInfo('2026-07-03', TODAY)).toEqual({ label: 'in 1d', cls: 'soon' });
    expect(expiryInfo('2026-07-05', TODAY)).toEqual({ label: 'in 3d', cls: 'soon' });
  });

  it('counts down within two weeks, then shows the date', () => {
    expect(expiryInfo('2026-07-10', TODAY)).toEqual({ label: 'in 8d', cls: 'ok' });
    expect(expiryInfo('2026-09-12', TODAY)).toEqual({ label: '12 Sept 2026', cls: 'ok' });
  });

  it('passes malformed values through unstyled', () => {
    expect(expiryInfo('not a date', TODAY)).toEqual({ label: 'not a date', cls: 'ok' });
  });
});
