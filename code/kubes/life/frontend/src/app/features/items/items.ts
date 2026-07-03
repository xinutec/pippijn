import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';

import { ExpiryInfo, expiryInfo } from '../../expiry';
import { LifeApi } from '../../life-api';
import { ProductThumb } from '../../product-thumb';
import { ListState } from '../../shared/list-state';
import { Item, Loc } from '../../models';

type SortKey = 'name' | 'expiry';

/** The complete, flat list of every item that exists — display fields resolved
 *  through the catalog product (name/brand/image) where one is linked. The
 *  "find my stuff" surface: a live name/brand/location filter + a sort. Reached
 *  from the hamburger menu. */
@Component({
  selector: 'app-items',
  templateUrl: './items.html',
  styleUrl: './items.scss',
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatInputModule,
    MatListModule,
    MatIconModule,
    ProductThumb,
    ListState,
  ],
})
export class Items {
  private api = inject(LifeApi);

  readonly items = signal<Item[]>([]);
  readonly locations = signal<Loc[]>([]);
  /** Pre-fetch, an empty list means "still loading", not "no items" — don't
   *  flash the empty message. */
  readonly loaded = signal(false);
  /** A load failure is NOT an empty inventory — show a retry, not "no items". */
  readonly loadError = signal(false);

  /** Live filter over name/brand/location, and the sort order. */
  readonly query = signal('');
  readonly sort = signal<SortKey>('name');

  private readonly byId = computed(() => new Map(this.locations().map((l) => [l.id, l] as const)));

  /** Items after the filter + sort — what the list renders. */
  readonly visible = computed<Item[]>(() => {
    const q = this.query().trim().toLowerCase();
    const matches = q
      ? this.items().filter((it) =>
          [it.name, it.brand, this.location(it)].some((s) => s?.toLowerCase().includes(q)),
        )
      : this.items().slice();
    if (this.sort() === 'expiry') {
      // Soonest expiry first; undated items sink to the bottom.
      matches.sort((a, b) => (a.expiry ?? '9999').localeCompare(b.expiry ?? '9999'));
    } else {
      matches.sort((a, b) => a.name.localeCompare(b.name));
    }
    return matches;
  });
  readonly count = computed(() => this.visible().length);

  constructor() {
    this.reload();
    this.api.locations().subscribe((l) => this.locations.set(l));
  }

  reload(): void {
    this.loadError.set(false);
    this.api.items().subscribe({
      next: (i) => {
        this.items.set(i);
        this.loaded.set(true);
      },
      error: () => {
        this.loaded.set(true);
        this.loadError.set(true);
      },
    });
  }

  /** Last two segments of the location path, or '' when unplaced. */
  private location(it: Item): string {
    const map = this.byId();
    const names: string[] = [];
    const seen = new Set<number>();
    let id = it.location_id;
    while (id != null && !seen.has(id)) {
      seen.add(id);
      const loc = map.get(id);
      if (!loc) break;
      names.unshift(loc.name);
      id = loc.parent_id;
    }
    return names.slice(-2).join(' › ');
  }

  /** Compact subtitle: "2 jar · food · Spice cupboard › Top shelf". */
  meta(it: Item): string {
    const qty = it.quantity == null ? '' : it.unit ? `${it.quantity} ${it.unit}` : `${it.quantity}`;
    return [qty, it.category, this.location(it)].filter((s) => s).join(' · ');
  }

  /** Urgency-aware expiry display (expired / soon / date). */
  expiryOf(expiry: string): ExpiryInfo {
    return expiryInfo(expiry);
  }
}
