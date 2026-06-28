import { Component, computed, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';

import { LifeApi } from '../../life-api';
import { Item, Loc } from '../../models';

@Component({
  selector: 'app-inventory',
  templateUrl: './inventory.html',
  styleUrl: './inventory.scss',
  imports: [MatListModule, MatIconModule, MatCardModule],
})
export class Inventory {
  private api = inject(LifeApi);

  readonly items = signal<Item[]>([]);
  readonly locations = signal<Loc[]>([]);
  private byId = computed(() => new Map(this.locations().map((l) => [l.id, l] as const)));

  constructor() {
    this.api.items().subscribe((i) => this.items.set(i));
    this.api.locations().subscribe((l) => this.locations.set(l));
  }

  /** Root→leaf breadcrumb for a location id, resolved client-side. */
  pathOf(id: number | null): string {
    if (id == null) return '';
    const map = this.byId();
    const names: string[] = [];
    const seen = new Set<number>();
    let cur: number | null = id;
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      const loc = map.get(cur);
      if (!loc) break;
      names.unshift(loc.name);
      cur = loc.parent_id;
    }
    return names.join(' › ');
  }

  qty(item: Item): string {
    if (item.quantity == null) return '';
    return item.unit ? `${item.quantity} ${item.unit}` : `${item.quantity}`;
  }
}
