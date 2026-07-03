import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import {
  MAT_BOTTOM_SHEET_DATA,
  MatBottomSheetRef,
} from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

import { Feedback } from '../../shared/feedback';
import { SheetHeader } from '../../shared/sheet-header';
import { WELLBEING_SCORES } from '../../shared/wellbeing-checkin';
import { WellbeingDoc, WellbeingStore } from '../../sync/wellbeing-store';

/** ISO instant → the value a <input type="datetime-local"> expects (local). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Edit one check-in: change the score, add/edit a note, adjust the time (to
 *  backdate "this morning"), or delete it. */
@Component({
  selector: 'app-wellbeing-entry',
  templateUrl: './wellbeing-entry.html',
  styleUrl: './wellbeing-entry.scss',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, SheetHeader],
})
export class WellbeingEntry implements OnDestroy {
  private ref = inject(MatBottomSheetRef<WellbeingEntry>);
  private data = inject<{ ulid: string }>(MAT_BOTTOM_SHEET_DATA);
  private store = inject(WellbeingStore);
  private feedback = inject(Feedback);

  private deleting = false;
  private items = toSignal(this.store.items$, { initialValue: [] as WellbeingDoc[] });

  readonly scores = WELLBEING_SCORES;
  readonly ulid = this.data.ulid;
  readonly entry = computed(() => this.items().find((e) => e.ulid === this.ulid));

  readonly note = signal(this.entry()?.note ?? '');
  readonly localTime = computed(() => {
    const e = this.entry();
    return e ? toLocalInput(e.recordedAt) : '';
  });

  // Flush an in-progress note edit if the sheet is dismissed without a blur.
  ngOnDestroy(): void {
    if (this.deleting) return;
    const e = this.entry();
    if (e && this.note().trim() !== (e.note ?? '')) this.saveNote();
  }

  setScore(score: number): void {
    void this.store.patch(this.ulid, { score });
  }

  saveNote(): void {
    void this.store.patch(this.ulid, { note: this.note().trim() || null });
  }

  setTime(local: string): void {
    if (!local) return;
    void this.store.patch(this.ulid, { recordedAt: new Date(local).toISOString() });
  }

  remove(): void {
    const e = this.entry();
    this.deleting = true;
    void this.store.remove(this.ulid);
    this.ref.dismiss();
    if (e) this.feedback.undo('Check-in deleted', () => void this.store.revive(e));
  }

  close(): void {
    this.ref.dismiss();
  }
}
