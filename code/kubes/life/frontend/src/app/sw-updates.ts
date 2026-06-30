import { Injectable, inject } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/** Self-update: when the service worker has finished caching a newer version,
 *  activate it and reload. The check runs at startup, so any reload happens
 *  before you've really started — you basically never see it, and you never
 *  have to kill-and-reopen the app to get the latest. No reload loop: after the
 *  reload the new version is the active one, so no further VERSION_READY fires. */
@Injectable({ providedIn: 'root' })
export class SwUpdates {
  private readonly sw = inject(SwUpdate);

  start(): void {
    if (!this.sw.isEnabled) return; // dev build has no service worker
    this.sw.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => this.applyUpdate());
    void this.sw.checkForUpdate();
  }

  // Separate method so it's a clean seam to assert in tests without reloading.
  applyUpdate(): void {
    void this.sw.activateUpdate().then(() => document.location.reload());
  }
}
