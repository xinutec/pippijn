import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { WellbeingStore, WellbeingDoc } from '../../sync/wellbeing-store';
import { Wellbeing } from './wellbeing';

/** ISO instant `daysAgo` days back at a given local time. */
const at = (daysAgo: number, h: number, m = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const entry = (over: Partial<WellbeingDoc>): WellbeingDoc => ({
  ulid: 'u',
  id: 1,
  recordedAt: at(0, 12),
  score: 3,
  note: null,
  rev: 1,
  ...over,
});

describe('Wellbeing history', () => {
  function setup(items: WellbeingDoc[]) {
    const store = { items$: of(items), syncError: signal<string | null>(null) };
    const sheet = { open: vi.fn() };
    TestBed.configureTestingModule({
      imports: [Wellbeing],
      providers: [{ provide: WellbeingStore, useValue: store }],
    });
    TestBed.overrideProvider(MatBottomSheet, { useValue: sheet });
    return { fixture: TestBed.createComponent(Wellbeing), sheet };
  }

  it('groups entries by local day, newest day first', () => {
    // Provided newest-first, as the store sorts them.
    const items = [
      entry({ ulid: 'a', recordedAt: at(0, 15), score: 4 }),
      entry({ ulid: 'b', recordedAt: at(0, 9), score: 2 }),
      entry({ ulid: 'c', recordedAt: at(1, 10), score: 3 }),
    ];
    const days = setup(items).fixture.componentInstance.days();
    expect(days.length).toBe(2);
    expect(days[0].label).toBe('Today');
    expect(days[0].entries.map((e) => e.ulid)).toEqual(['a', 'b']);
    expect(days[1].label).toBe('Yesterday');
  });

  it('plots a chart dot per recent entry and none for old ones', () => {
    const items = [
      entry({ ulid: 'a', recordedAt: at(0, 12), score: 5 }),
      entry({ ulid: 'z', recordedAt: at(40, 12), score: 1 }), // outside the 14-day window
    ];
    const c = setup(items).fixture.componentInstance;
    expect(c.chart().dots.length).toBe(1);
    expect(c.hasChart()).toBe(true);
  });

  it('opens the edit sheet for an entry', () => {
    const { fixture, sheet } = setup([entry({ ulid: 'a' })]);
    fixture.componentInstance.edit(entry({ ulid: 'a' }));
    expect(sheet.open).toHaveBeenCalled();
  });
});
