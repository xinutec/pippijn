import { Component, computed, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';

import { LifeApi } from '../../life-api';
import { Item } from '../../models';
import { showThumb } from '../../product-image';
import { daysUntil, ExpiryStatus, expiryLabel, statusOf } from './expiry-status';

interface Row {
  item: Item;
  days: number;
  status: ExpiryStatus;
  label: string;
}

/** "Use soon": every item that has an expiry date, soonest first, coloured by
 *  urgency (expired / soon / later). Reached from the hamburger menu. */
@Component({
  selector: 'app-expiring',
  templateUrl: './expiring.html',
  styleUrl: './expiring.scss',
  imports: [MatListModule, MatIconModule],
})
export class Expiring {
  private api = inject(LifeApi);
  private readonly items = signal<Item[]>([]);
  private readonly imgFailed = signal<Set<number>>(new Set());

  readonly rows = computed<Row[]>(() =>
    this.items()
      .map((item) => ({ item, days: daysUntil(item.expiry) }))
      .filter((r): r is { item: Item; days: number } => r.days !== null)
      .map(({ item, days }) => ({ item, days, status: statusOf(days), label: expiryLabel(days) }))
      .sort((a, b) => a.days - b.days),
  );

  constructor() {
    this.api.items().subscribe((i) => this.items.set(i));
  }

  imageUrl(it: Item): string | null {
    return showThumb(it, this.imgFailed().has(it.id)) ? this.api.productImageUrl(it.barcode!) : null;
  }
  onImgError(id: number): void {
    this.imgFailed.update((s) => new Set(s).add(id));
  }
}
