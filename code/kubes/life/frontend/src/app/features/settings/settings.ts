import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';

import { BUILD_INFO } from '../../build-info';
import { SwUpdates } from '../../sw-updates';

/** Settings — the natural home for app-level bits (the build version today; NC
 *  link, preferences, etc. later). The version is stamped into the bundle at
 *  build time (see scripts/stamp-version.mjs), so what shows here is the build
 *  actually running in *this* tab — a stale PWA reveals its own old sha rather
 *  than the server's current one. "Check for updates" forces the service worker
 *  to fetch a newer build and reload. */
@Component({
  selector: 'app-settings',
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  imports: [MatCardModule, MatButtonModule, MatIconModule],
})
export class Settings {
  private swUpdates = inject(SwUpdates);
  private snack = inject(MatSnackBar);

  protected readonly build = BUILD_INFO;
  /** Localized build time, or '' when unknown (a bare/dev stamp). */
  protected readonly builtAt = BUILD_INFO.builtAt
    ? new Date(BUILD_INFO.builtAt).toLocaleString()
    : '';
  protected readonly checking = signal(false);

  protected async checkForUpdates(): Promise<void> {
    this.checking.set(true);
    try {
      const result = await this.swUpdates.checkNow();
      if (result === 'updating') {
        this.snack.open('New version found — updating…', undefined, { duration: 4000 });
      } else if (result === 'current') {
        this.snack.open('You’re on the latest version.', 'OK', { duration: 3000 });
      } else {
        this.snack.open('Updates aren’t available in this build.', 'OK', { duration: 3000 });
      }
    } finally {
      this.checking.set(false);
    }
  }
}
