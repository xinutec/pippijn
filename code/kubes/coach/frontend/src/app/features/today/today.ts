import { Component, inject, signal } from "@angular/core";
import { MatBottomSheet } from "@angular/material/bottom-sheet";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { forkJoin } from "rxjs";

import { CoachApi } from "../../coach-api";
import { Exercise, PacingNow } from "../../models";
import { LogSheet, LogSheetData } from "../log/log-sheet";

@Component({
  selector: "app-today",
  templateUrl: "./today.html",
  styleUrl: "./today.scss",
  imports: [MatButtonModule, MatCardModule, MatIconModule, MatProgressBarModule],
})
export class Today {
  private api = inject(CoachApi);
  private sheet = inject(MatBottomSheet);

  readonly pacing = signal<PacingNow | null>(null);
  readonly exercises = signal<Exercise[]>([]);
  readonly loading = signal(true);
  readonly starting = signal(false);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    forkJoin({
      pacing: this.api.pacingNow(),
      exercises: this.api.exercises(),
    }).subscribe({
      next: ({ pacing, exercises }) => {
        this.pacing.set(pacing);
        this.exercises.set(exercises);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  patternLabel(p: string): string {
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  pct(done: number, target: number): number {
    return target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
  }

  startStarter(): void {
    this.starting.set(true);
    this.api.createStarter().subscribe({
      next: () => {
        this.starting.set(false);
        this.reload();
      },
      error: () => this.starting.set(false),
    });
  }

  openLog(fromSuggestion = false): void {
    const p = this.pacing();
    const data: LogSheetData = { exercises: this.exercises() };
    if (fromSuggestion && p?.suggestion) {
      data.prefill = {
        exerciseId: p.suggestion.exerciseId,
        reps: p.suggestion.repLow,
        loadKg: p.suggestion.loadKg,
        holdS: p.suggestion.holdS,
      };
    }
    this.sheet
      .open(LogSheet, { data })
      .afterDismissed()
      .subscribe((res) => {
        if (res) this.reload();
      });
  }
}
