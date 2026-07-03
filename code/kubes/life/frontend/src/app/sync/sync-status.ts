import { Injectable, computed, signal } from '@angular/core';

/** Whole-app sync health, in priority order: a device that's offline reports
 *  `offline` even if replication is erroring, because a failed fetch is the
 *  expected symptom of being offline, not a fault to alarm about. */
export type SyncHealth = 'synced' | 'offline' | 'error';

/** The one place that knows whether local edits have actually reached the
 *  server. Before this, a stalled/failed push was silent — data looked saved
 *  (it's in IndexedDB) but never synced, with no signal anywhere. Every
 *  replication reports its cycle outcome here; the shell renders a persistent
 *  indicator whenever health() isn't `synced`.
 *
 *  Kept dependency-free and push-updated (no polling): signals in, computed
 *  out. Errors are tracked per source (store label) so one failing collection
 *  doesn't mask another recovering. */
@Injectable({ providedIn: 'root' })
export class SyncStatus {
  /** navigator.onLine, kept live via the window online/offline events. */
  private readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  /** Latest failure message per replication source; empty object = all healthy. */
  private readonly errors = signal<Record<string, string>>({});

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.online.set(true));
      window.addEventListener('offline', () => this.online.set(false));
    }
  }

  readonly health = computed<SyncHealth>(() => {
    if (!this.online()) return 'offline';
    return Object.keys(this.errors()).length > 0 ? 'error' : 'synced';
  });

  /** A short human message for the current health — tooltip + aria-label. */
  readonly message = computed<string>(() => {
    if (!this.online()) {
      return 'Offline — changes are saved on this device and will sync when you reconnect.';
    }
    const [first] = Object.values(this.errors());
    if (first) return first;
    return 'All changes synced.';
  });

  /** A replication cycle failed. `source` is the store label; last message wins. */
  reportError(source: string, message: string): void {
    this.errors.update((e) => (e[source] === message ? e : { ...e, [source]: message }));
  }

  /** A replication cycle for `source` completed cleanly. */
  clearError(source: string): void {
    this.errors.update((e) => {
      if (!(source in e)) return e;
      const next = { ...e };
      delete next[source];
      return next;
    });
  }
}
