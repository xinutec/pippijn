import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';

import { LifeApi } from '../../life-api';
import { Item, ItemCategory, Loc, LocationKind } from '../../models';

const KINDS: LocationKind[] = ['house', 'room', 'cupboard', 'fridge', 'layer'];
const CATEGORIES: ItemCategory[] = ['food', 'medication', 'tool', 'document', 'other'];

interface PlaceForm {
  kind: LocationKind;
  name: string;
  parent_id: number | null;
}

interface ItemForm {
  name: string;
  category: ItemCategory;
  quantity: number | null;
  unit: string | null;
  expiry: string | null;
  location_id: number | null;
}

@Component({
  selector: 'app-inventory',
  templateUrl: './inventory.html',
  styleUrl: './inventory.scss',
  imports: [
    FormsModule,
    MatListModule,
    MatIconModule,
    MatCardModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatMenuModule,
  ],
})
export class Inventory {
  private api = inject(LifeApi);

  readonly kinds = KINDS;
  readonly categories = CATEGORIES;

  readonly items = signal<Item[]>([]);
  readonly locations = signal<Loc[]>([]);
  private byId = computed(() => new Map(this.locations().map((l) => [l.id, l] as const)));
  readonly locationOptions = computed(() =>
    this.locations().map((l) => ({ id: l.id, label: this.pathOf(l.id) })),
  );

  place: PlaceForm = this.emptyPlace();
  item: ItemForm = this.emptyItem();
  readonly editingId = signal<number | null>(null);
  readonly showItemForm = signal(false);
  readonly showPlaceForm = signal(false);

  toggleItemForm(): void {
    this.showItemForm.update((v) => !v);
  }
  togglePlaceForm(): void {
    this.showPlaceForm.update((v) => !v);
  }

  constructor() {
    this.reloadItems();
    this.reloadLocations();
  }

  private reloadItems(): void {
    this.api.items().subscribe((i) => this.items.set(i));
  }
  private reloadLocations(): void {
    this.api.locations().subscribe((l) => this.locations.set(l));
  }
  private emptyPlace(): PlaceForm {
    return { kind: 'cupboard', name: '', parent_id: null };
  }
  private emptyItem(): ItemForm {
    return { name: '', category: 'food', quantity: null, unit: null, expiry: null, location_id: null };
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

  /** The actionable tail of the location path (e.g. "Spice cupboard › Top shelf"). */
  shortLoc(id: number | null): string {
    if (id == null) return '';
    return this.pathOf(id).split(' › ').slice(-2).join(' › ');
  }

  addPlace(): void {
    if (!this.place.name.trim()) return;
    this.api.createLocation({ ...this.place }).subscribe(() => {
      this.place = this.emptyPlace();
      this.reloadLocations();
    });
  }

  deletePlace(id: number): void {
    this.api.deleteLocation(id).subscribe(() => {
      this.reloadLocations();
      this.reloadItems(); // items there are now unplaced
    });
  }

  saveItem(): void {
    if (!this.item.name.trim()) return;
    const body = { ...this.item };
    const id = this.editingId();
    const req = id ? this.api.updateItem(id, body) : this.api.createItem(body);
    req.subscribe(() => {
      this.cancelEdit();
      this.reloadItems();
    });
  }

  editItem(it: Item): void {
    this.item = {
      name: it.name,
      category: it.category,
      quantity: it.quantity,
      unit: it.unit,
      expiry: it.expiry,
      location_id: it.location_id,
    };
    this.editingId.set(it.id);
    this.showItemForm.set(true);
  }

  cancelEdit(): void {
    this.item = this.emptyItem();
    this.editingId.set(null);
  }

  deleteItem(id: number): void {
    this.api.deleteItem(id).subscribe(() => this.reloadItems());
  }
}
