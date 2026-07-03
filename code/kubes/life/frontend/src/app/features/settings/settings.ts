import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';

import { BUILD_INFO } from '../../build-info';
import { Feedback } from '../../shared/feedback';
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
  imports: [MatCardModule, MatButtonModule, MatIconModule, MatListModule],
})
export class Settings {
  private swUpdates = inject(SwUpdates);
  private feedback = inject(Feedback);

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
        this.feedback.notify('New version found — updating…');
      } else if (result === 'current') {
        this.feedback.notify('You’re on the latest version.');
      } else {
        this.feedback.error('Updates aren’t available in this build.');
      }
    } finally {
      this.checking.set(false);
    }
  }
}
