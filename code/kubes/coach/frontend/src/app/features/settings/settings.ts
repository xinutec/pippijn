import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";

import { CoachApi } from "../../coach-api";
import { Settings } from "../../models";
import { SwUpdates } from "../../sw-updates";

@Component({
  selector: "app-settings",
  templateUrl: "./settings.html",
  styleUrl: "./settings.scss",
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
  ],
})
export class SettingsPage {
  private api = inject(CoachApi);
  private swUpdates = inject(SwUpdates);

  form: Settings | null = null;
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly updateMsg = signal("");

  constructor() {
    this.api.settings().subscribe((s) => (this.form = s));
  }

  save(): void {
    if (!this.form) return;
    this.saving.set(true);
    this.api.patchSettings({ ...this.form }).subscribe({
      next: (s) => {
        this.form = s;
        this.saving.set(false);
        this.saved.set(true);
        setTimeout(() => this.saved.set(false), 2000);
      },
      error: () => this.saving.set(false),
    });
  }

  async checkUpdates(): Promise<void> {
    const r = await this.swUpdates.checkNow();
    this.updateMsg.set(
      r === "current"
        ? "Up to date."
        : r === "updating"
          ? "Updating…"
          : "No service worker (dev build).",
    );
  }
}
