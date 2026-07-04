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

  // Signal so a zoneless view refreshes when the async load/save resolves. The
  // form fields two-way-bind to the held object's properties (mutating them in
  // place is fine — only the object reference is swapped via .set()).
  readonly form = signal<Settings | null>(null);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly updateMsg = signal("");

  constructor() {
    this.api.settings().subscribe((s) => this.form.set(s));
  }

  save(): void {
    const f = this.form();
    if (!f) return;
    this.saving.set(true);
    this.api.patchSettings({ ...f }).subscribe({
      next: (s) => {
        this.form.set(s);
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
