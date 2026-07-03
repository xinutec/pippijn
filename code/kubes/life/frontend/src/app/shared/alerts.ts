import { Injectable, inject, signal } from '@angular/core';

import { LifeApi } from '../life-api';

/** App-wide "needs your attention" counters, surfaced as badges on the menu.
 *  Currently just unresolved sync conflicts — the one thing that silently needs
 *  human adjudication (both devices edited the same field). Kept tiny and
 *  push-updated so no polling is needed. */
@Injectable({ providedIn: 'root' })
export class Alerts {
  private api = inject(LifeApi);

  /** Number of unresolved sync conflicts. Drives the hamburger + menu badge. */
  readonly conflictCount = signal(0);

  /** Fetch the authoritative count (on app start; the Conflicts screen also
   *  sets it precisely as it loads/resolves). Fails soft to no change. */
  refreshConflicts(): void {
    this.api.conflicts().subscribe({
      next: (list) => this.conflictCount.set(list.length),
      error: () => {},
    });
  }

  /** Set the exact count (Conflicts screen, after load/resolve). */
  setConflicts(n: number): void {
    this.conflictCount.set(Math.max(0, n));
  }

  /** Optimistically bump when the merge just logged conflicts, so the badge
   *  appears immediately without a round-trip. */
  addConflicts(n: number): void {
    if (n > 0) this.conflictCount.update((c) => c + n);
  }
}
