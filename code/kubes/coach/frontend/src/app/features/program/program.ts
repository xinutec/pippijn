import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";
import { forkJoin } from "rxjs";

import { CoachApi } from "../../coach-api";
import { Exercise, Pattern, ProgramDetail, ProgramTarget } from "../../models";

const PATTERNS: Pattern[] = ["push", "pull", "legs", "core"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface PatternGroup {
  pattern: Pattern;
  rows: { target: ProgramTarget; ex: Exercise }[];
}

@Component({
  selector: "app-program",
  templateUrl: "./program.html",
  styleUrl: "./program.scss",
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
  ],
})
export class ProgramPage {
  private api = inject(CoachApi);
  readonly weekdays = WEEKDAYS;

  readonly detail = signal<ProgramDetail | null>(null);
  readonly exMap = signal<Map<number, Exercise>>(new Map());
  readonly exercises = signal<Exercise[]>([]);
  readonly loading = signal(true);
  readonly starting = signal(false);
  readonly selectedWeek = signal(1);
  readonly savedId = signal<number | null>(null);

  // Add-pin form. exerciseId is a signal (set asynchronously after the load, so
  // a zoneless view must be refreshed); weekday/sets are only user-typed via
  // ngModel, so plain fields are fine.
  readonly pinExerciseId = signal<number | null>(null);
  pinWeekday = 0;
  pinSets = 1;

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    forkJoin({
      detail: this.api.activeProgram(),
      exercises: this.api.exercises(true),
    }).subscribe({
      next: ({ detail, exercises }) => {
        this.detail.set(detail);
        this.exercises.set(exercises);
        this.exMap.set(new Map(exercises.map((e) => [e.id, e])));
        this.pinExerciseId.set(exercises[0]?.id ?? null);
        if (detail) this.selectedWeek.set(this.currentWeek(detail));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  private currentWeek(d: ProgramDetail): number {
    const start = new Date(d.program.startDate + "T00:00:00");
    const today = new Date();
    const days = Math.floor((today.getTime() - start.getTime()) / 86400000);
    return Math.min(Math.max(Math.floor(days / 7) + 1, 1), d.program.weeks);
  }

  readonly weeksArr = computed(() => {
    const d = this.detail();
    return d ? Array.from({ length: d.program.weeks }, (_, i) => i + 1) : [];
  });

  readonly groups = computed<PatternGroup[]>(() => {
    const d = this.detail();
    if (!d) return [];
    const week = this.selectedWeek();
    const forWeek = d.targets.filter((t) => t.weekIndex === week);
    const out: PatternGroup[] = [];
    for (const pattern of PATTERNS) {
      const rows = forWeek
        .map((target) => ({ target, ex: this.exMap().get(target.exerciseId) }))
        .filter((r): r is { target: ProgramTarget; ex: Exercise } => !!r.ex)
        .filter((r) => r.ex.pattern === pattern);
      if (rows.length) out.push({ pattern, rows });
    }
    return out;
  });

  patternLabel(p: string): string {
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  isDeload(week: number): boolean {
    return this.detail()?.program.deloadWeek === week;
  }

  saveTarget(t: ProgramTarget): void {
    this.api
      .patchTarget(t.id, {
        targetSets: t.targetSets,
        repLow: t.repLow,
        repHigh: t.repHigh,
        loadKg: t.loadKg,
        holdS: t.holdS,
      })
      .subscribe((updated) => {
        this.savedId.set(updated.id);
        setTimeout(() => {
          if (this.savedId() === updated.id) this.savedId.set(null);
        }, 1500);
      });
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

  pinLabel(exerciseId: number, weekday: number): string {
    return `${this.exMap().get(exerciseId)?.name ?? "Exercise"} · ${WEEKDAYS[weekday]}`;
  }

  addPin(): void {
    const d = this.detail();
    const exId = this.pinExerciseId();
    if (!d || exId == null) return;
    this.api
      .upsertPin(d.program.id, {
        exerciseId: exId,
        weekday: this.pinWeekday,
        sets: this.pinSets,
      })
      .subscribe(() => this.reload());
  }

  removePin(pinId: number): void {
    const d = this.detail();
    if (!d) return;
    this.api.deletePin(d.program.id, pinId).subscribe(() => this.reload());
  }
}
