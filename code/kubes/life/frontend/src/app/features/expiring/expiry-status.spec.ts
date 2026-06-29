import { describe, expect, it } from 'vitest';

import { daysUntil, expiryLabel, statusOf } from './expiry-status';

const TODAY = new Date(2026, 6, 1); // 2026-07-01 (local)

describe('daysUntil', () => {
  it('counts whole days, negative for the past, null for missing/invalid', () => {
    expect(daysUntil('2026-07-01', TODAY)).toBe(0);
    expect(daysUntil('2026-07-08', TODAY)).toBe(7);
    expect(daysUntil('2026-06-28', TODAY)).toBe(-3);
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(daysUntil('not-a-date', TODAY)).toBeNull();
  });
});

describe('statusOf', () => {
  it('buckets expired / soon (≤7) / later', () => {
    expect(statusOf(-1)).toBe('expired');
    expect(statusOf(0)).toBe('soon');
    expect(statusOf(7)).toBe('soon');
    expect(statusOf(8)).toBe('later');
  });
});

describe('expiryLabel', () => {
  it('reads naturally', () => {
    expect(expiryLabel(0)).toBe('today');
    expect(expiryLabel(1)).toBe('tomorrow');
    expect(expiryLabel(5)).toBe('in 5 days');
    expect(expiryLabel(-1)).toBe('expired yesterday');
    expect(expiryLabel(-4)).toBe('expired 4 days ago');
  });
});
