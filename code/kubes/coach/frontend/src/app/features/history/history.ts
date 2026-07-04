import { Component, computed, inject, signal } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { forkJoin } from "rxjs";

import { CoachApi } from "../../coach-api";
import { Exercise, WorkoutSet } from "../../models";

interface DayGroup {
  key: string;
  label: string;
  sets: WorkoutSet[];
}

@Component({
  selector: "app-history",
  templateUrl: "./history.html",
  styleUrl: "./history.scss",
  imports: [MatButtonModule, MatIconModule],
})
export class HistoryPage {
  private api = inject(CoachApi);

  readonly sets = signal<WorkoutSet[]>([]);
  readonly exMap = signal<Map<number, Exercise>>(new Map());
  readonly loading = signal(true);

  // logged_at is stored UTC; append 'Z' so the browser renders local time.
  private local(loggedAt: string): Date {
    return new Date(loggedAt + "Z");
  }

  readonly groups = computed<DayGroup[]>(() => {
    const byDay = new Map<string, WorkoutSet[]>();
    for (const s of this.sets()) {
      const d = this.local(s.loggedAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const list = byDay.get(key);
      if (list) list.push(s);
      else byDay.set(key, [s]);
    }
    return [...byDay.values()].map((sets) => ({
      key: `${this.local(sets[0].loggedAt).getFullYear()}-${this.local(sets[0].loggedAt).getMonth()}-${this.local(sets[0].loggedAt).getDate()}`,
      label: this.local(sets[0].loggedAt).toLocaleDateString([], {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
      sets,
    }));
  });

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    forkJoin({
      sets: this.api.sets(100),
      exercises: this.api.exercises(true),
    }).subscribe({
      next: ({ sets, exercises }) => {
        this.sets.set(sets);
        this.exMap.set(new Map(exercises.map((e) => [e.id, e])));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  name(id: number): string {
    return this.exMap().get(id)?.name ?? "Exercise";
  }

  detail(s: WorkoutSet): string {
    const parts: string[] = [];
    if (s.reps != null) parts.push(`${s.reps} reps`);
    if (s.loadKg != null) parts.push(`${s.loadKg} kg`);
    if (s.holdS != null) parts.push(`${s.holdS}s`);
    if (s.rpe != null) parts.push(`RPE ${s.rpe}`);
    return parts.join(" · ");
  }

  time(s: WorkoutSet): string {
    return this.local(s.loggedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  del(s: WorkoutSet): void {
    this.api
      .deleteSet(s.id)
      .subscribe(() => this.sets.set(this.sets().filter((x) => x.id !== s.id)));
  }
}
