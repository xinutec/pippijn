import { describe, expect, it } from 'vitest';
import { fmtValue, formatAge, freshnessLabel, tileClass } from './status';

describe('status helpers', () => {
  it('tile shows worst verdict when fresh', () => {
    expect(tileClass('pass', 'fresh')).toBe('pass');
    expect(tileClass('warn', 'fresh')).toBe('warn');
    expect(tileClass('fail', 'fresh')).toBe('fail');
  });

  it('staleness overrides the verdict — a dead producer is never green', () => {
    expect(tileClass('pass', 'overdue')).toBe('warn');
    expect(tileClass('pass', 'silent')).toBe('fail');
    // even if the last data was passing, silence wins.
    expect(tileClass('pass', 'silent')).not.toBe('pass');
  });

  it('labels only non-fresh states', () => {
    expect(freshnessLabel('fresh')).toBeNull();
    expect(freshnessLabel('overdue')).toBe('overdue');
    expect(freshnessLabel('silent')).toBe('no data');
  });

  it('attaches symbol units, spaces word units', () => {
    expect(fmtValue(43, '%')).toBe('43%');
    expect(fmtValue(0, 'violations')).toBe('0 violations');
    expect(fmtValue(68, 'days')).toBe('68 days');
    expect(fmtValue(12, null)).toBe('12');
    expect(fmtValue(21, '')).toBe('21');
  });

  it('formats age in coarse human units', () => {
    expect(formatAge(10)).toBe('just now');
    expect(formatAge(120)).toBe('2m ago');
    expect(formatAge(3600)).toBe('1h ago');
    expect(formatAge(3 * 86400)).toBe('3d ago');
  });
});
