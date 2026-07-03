import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { Feedback } from './feedback';
import { WellbeingCheckin } from './wellbeing-checkin';
import { WellbeingStore } from '../sync/wellbeing-store';

describe('WellbeingCheckin', () => {
  function setup() {
    const store = {
      add: vi.fn<(input: { recordedAt: string; score: number; note: string | null }) => Promise<string>>(
        () => Promise.resolve('u1'),
      ),
      remove: vi.fn(),
    };
    const feedback = { undo: vi.fn<(msg: string, onUndo: () => void) => void>() };
    TestBed.configureTestingModule({
      imports: [WellbeingCheckin],
      providers: [
        { provide: WellbeingStore, useValue: store },
        { provide: Feedback, useValue: feedback },
      ],
    });
    return { fixture: TestBed.createComponent(WellbeingCheckin), store, feedback };
  }

  it('logs a check-in at "now" with the tapped score and offers Undo', async () => {
    const { fixture, store, feedback } = setup();
    await fixture.componentInstance.log(4);
    expect(store.add).toHaveBeenCalledTimes(1);
    const [input] = store.add.mock.calls[0];
    expect(input.score).toBe(4);
    expect(input.note).toBeNull();
    expect(typeof input.recordedAt).toBe('string');
    expect(feedback.undo).toHaveBeenCalled();
  });

  it('Undo removes the just-created entry', async () => {
    const { fixture, store, feedback } = setup();
    await fixture.componentInstance.log(1);
    // Invoke the onUndo callback the component handed to Feedback.undo.
    const onUndo = feedback.undo.mock.calls[0][1];
    onUndo();
    expect(store.remove).toHaveBeenCalledWith('u1');
  });
});
