import { Component, computed, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { ExpiryInfo, expiryInfo } from '../../expiry';
import { LifeApi } from '../../life-api';
import { ProductThumb } from '../../product-thumb';
import { Item, Loc } from '../../models';

/** The complete, flat list of every item that exists — display fields resolved
 *  through the catalog product (name/brand/image) where one is linked. A
 *  less-common view, reached from the hamburger menu. */
@Component({
  selector: 'app-items',
  templateUrl: './items.html',
  styleUrl: './items.scss',
  imports: [MatListModule, MatIconModule, MatProgressBarModule, ProductThumb],
})
export class Items {
  private api = inject(LifeApi);

  readonly items = signal<Item[]>([]);
  readonly locations = signal<Loc[]>([]);
  /** Pre-fetch, an empty list means "still loading", not "no items" — don't
   *  flash the empty message. */
  readonly loaded = signal(false);
  readonly count = computed(() => this.items().length);
  private readonly byId = computed(() => new Map(this.locations().map((l) => [l.id, l] as const)));

  constructor() {
    this.api.items().subscribe({
      next: (i) => {
        this.items.set(i);
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
    this.api.locations().subscribe((l) => this.locations.set(l));
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
