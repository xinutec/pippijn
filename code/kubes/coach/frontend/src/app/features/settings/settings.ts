import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";

import { CoachApi } from "../../coach-api";
import { Settings } from "../../models";
import { SwUpdates } from "../../sw-updates";

/** The native bridge the Android wrapper injects as `window.CoachAndroid`. Its
 *  presence is how we know we're running inside the app and can offer the
 *  on-device home-geofence reminders (the geofence + notifications are native;
 *  the home location never leaves the phone). Absent in a plain browser. */
interface CoachAndroidBridge {
  remindersStatus(): string;
  setupReminders(): void;
  disableReminders(): void;
}
function coachAndroid(): CoachAndroidBridge | null {
  return (window as unknown as { CoachAndroid?: CoachAndroidBridge }).CoachAndroid ?? null;
}

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

  // Home-reminders state, only meaningful inside the Android app.
  readonly isAndroid = signal(false);
  readonly remindersArmed = signal(false);
  readonly remindersHasHome = signal(false);

  constructor() {
    this.api.settings().subscribe((s) => this.form.set(s));
    this.refreshReminders();
  }

  private refreshReminders(): void {
    const bridge = coachAndroid();
    this.isAndroid.set(bridge !== null);
    if (bridge === null) return;
    try {
      const status = JSON.parse(bridge.remindersStatus()) as {
        hasHome?: boolean;
        armed?: boolean;
      };
      this.remindersHasHome.set(status.hasHome === true);
      this.remindersArmed.set(status.armed === true);
    } catch {
      // Bridge returned something unexpected — leave the defaults.
    }
  }

  /** Kick off the native set-home + arm flow (permission dialogs are native).
   *  Status updates a moment later once the flow settles. */
  enableReminders(): void {
    coachAndroid()?.setupReminders();
    setTimeout(() => this.refreshReminders(), 1500);
  }

  disableReminders(): void {
    coachAndroid()?.disableReminders();
    setTimeout(() => this.refreshReminders(), 300);
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
