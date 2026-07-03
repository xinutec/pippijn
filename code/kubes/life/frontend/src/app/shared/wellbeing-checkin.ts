import { Component, inject, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { Feedback } from './feedback';
import { WellbeingStore } from '../sync/wellbeing-store';

/** The five wellbeing levels: score, label + Material face icon. Shared so the
 *  check-in strip, the history timeline and the edit sheet all agree. */
export const WELLBEING_SCORES: readonly { score: number; label: string; icon: string }[] = [
  { score: 1, label: 'awful', icon: 'sentiment_very_dissatisfied' },
  { score: 2, label: 'low', icon: 'sentiment_dissatisfied' },
  { score: 3, label: 'okay', icon: 'sentiment_neutral' },
  { score: 4, label: 'good', icon: 'sentiment_satisfied' },
  { score: 5, label: 'great', icon: 'sentiment_very_satisfied' },
];

export function scoreMeta(score: number) {
  return WELLBEING_SCORES.find((s) => s.score === score) ?? WELLBEING_SCORES[2];
}

/** The one-tap mood check-in: five face buttons that log an entry at "now".
 *  Logging is instant and offline; an Undo snackbar covers a mis-tap. Note and
 *  time adjustments are follow-ups on the history screen, never prerequisites. */
@Component({
  selector: 'app-wellbeing-checkin',
  templateUrl: './wellbeing-checkin.html',
  styleUrl: './wellbeing-checkin.scss',
  imports: [MatButtonModule, MatIconModule],
})
export class WellbeingCheckin {
  private store = inject(WellbeingStore);
  private feedback = inject(Feedback);

  /** Emitted after a check-in is logged (so a host can e.g. scroll to it). */
  readonly logged = output<void>();

  readonly scores = WELLBEING_SCORES;

  async log(score: number): Promise<void> {
    // Log at "now" immediately (offline-ok); a mis-tap is one Undo away. A
    // just-created entry is removed outright on undo — no server restore needed.
    const key = await this.store.add({ recordedAt: new Date().toISOString(), score, note: null });
    this.logged.emit();
    this.feedback.undo(`Logged ${scoreMeta(score).label}`, () => void this.store.remove(key));
  }
}
