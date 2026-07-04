import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import {
  MAT_BOTTOM_SHEET_DATA,
  MatBottomSheetRef,
} from "@angular/material/bottom-sheet";
import { MatButtonModule } from "@angular/material/button";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";

import { CoachApi } from "../../coach-api";
import { Exercise, WorkoutSet } from "../../models";

export interface LogPrefill {
  exerciseId: number;
  reps?: number | null;
  loadKg?: number | null;
  holdS?: number | null;
}
export interface LogSheetData {
  exercises: Exercise[];
  prefill?: LogPrefill;
}

/** Fast "log a set" bottom sheet. Fields shown adapt to the exercise's metric. */
@Component({
  selector: "app-log-sheet",
  templateUrl: "./log-sheet.html",
  styleUrl: "./log-sheet.scss",
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
})
export class LogSheet {
  private api = inject(CoachApi);
  private ref =
    inject<MatBottomSheetRef<LogSheet, WorkoutSet | null>>(MatBottomSheetRef);
  readonly data = inject<LogSheetData>(MAT_BOTTOM_SHEET_DATA);

  readonly exercises = this.data.exercises;
  readonly exerciseId = signal<number | null>(
    this.data.prefill?.exerciseId ?? this.exercises[0]?.id ?? null,
  );
  reps: number | null = this.data.prefill?.reps ?? null;
  loadKg: number | null = this.data.prefill?.loadKg ?? null;
  holdS: number | null = this.data.prefill?.holdS ?? null;
  rpe: number | null = null;
  note = "";
  readonly saving = signal(false);

  readonly selected = computed(
    () => this.exercises.find((e) => e.id === this.exerciseId()) ?? null,
  );

  save(): void {
    const id = this.exerciseId();
    if (id == null) return;
    this.saving.set(true);
    this.api
      .logSet({
        exerciseId: id,
        reps: this.reps,
        loadKg: this.loadKg,
        holdS: this.holdS,
        rpe: this.rpe,
        note: this.note.trim() || null,
        loggedAt: null,
      })
      .subscribe({
        next: (s) => this.ref.dismiss(s),
        error: () => this.saving.set(false),
      });
  }

  cancel(): void {
    this.ref.dismiss(null);
  }
}
