import { Injectable, inject } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/** Updates arriving this soon after start() reload immediately — nothing is in
 *  progress yet, so you basically never see it. */
const STARTUP_MS = 10_000;

/** Self-update: when the service worker has finished caching a newer version,
 *  activate it and reload — but never mid-use. The rules:
 *
 *  - **Startup / hidden**: reload right away (invisible either way).
 *  - **Mid-session, visible**: defer the reload until the app is next
 *    backgrounded, so an update never eats a half-typed form. Combined with the
 *    visibility re-check below, a PWA left open for days updates itself the
 *    moment you switch away and is fresh when you come back.
 *  - **Becoming visible**: re-check for a newer build. ngsw only re-checks on
 *    its own at a navigation, which a resumed long-lived tab never performs —
 *    this is the fix for the stale-tab problem.
 *
 *  No reload loop: after the reload the new version is the active one, so no
 *  further VERSION_READY fires. */
@Injectable({ providedIn: 'root' })
export class SwUpdates {
  private readonly sw = inject(SwUpdate);
  private startedAt = 0;
  private pendingReload = false;
  /** True while a Settings "Check for updates" is in flight — the user asked,
   *  so the resulting VERSION_READY applies immediately, no deferral. */
  private userAsked = false;

  start(): void {
    if (!this.sw.isEnabled) return; // dev build has no service worker
    this.startedAt = Date.now();
    this.sw.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => this.onVersionReady());
    document.addEventListener('visibilitychange', () => this.onVisibilityChange());
    void this.sw.checkForUpdate();
  }

  private onVersionReady(): void {
    const inStartup = Date.now() - this.startedAt < STARTUP_MS;
    if (this.userAsked || inStartup || document.visibilityState === 'hidden') {
      this.applyUpdate();
    } else {
      this.pendingReload = true;
    }
  }

  private onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
      if (this.pendingReload) this.applyUpdate();
    } else {
      void this.sw.checkForUpdate();
    }
  }

  // Separate method so it's a clean seam to assert in tests without reloading.
  applyUpdate(): void {
    void this.sw.activateUpdate().then(() => document.location.reload());
  }

  /** Manual "Check for updates" (Settings). Resolves to:
   *  - `'updating'`: a newer build was found — the `versionUpdates` handler
   *    above activates it and reloads, so the page is about to refresh.
   *  - `'current'`: already on the latest build.
   *  - `'unsupported'`: no service worker (dev build). */
  async checkNow(): Promise<'updating' | 'current' | 'unsupported'> {
    if (!this.sw.isEnabled) return 'unsupported';
    // checkForUpdate() resolves true when a new version was discovered; the
    // VERSION_READY subscription then drives activate + reload.
    this.userAsked = true;
    const found = await this.sw.checkForUpdate();
    if (!found) this.userAsked = false;
    return found ? 'updating' : 'current';
  }
}
