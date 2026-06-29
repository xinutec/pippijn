import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';

import { LifeApi } from '../../life-api';
import { Item, ItemCategory, Loc, LocationKind } from '../../models';
import { ScannerDialog } from '../scanner/scanner-dialog';

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
  barcode: string | null;
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
    MatDialogModule,
  ],
})
export class Inventory {
  private api = inject(LifeApi);
  private dialog = inject(MatDialog);

  readonly kinds = KINDS;
  readonly categories = CATEGORIES;

  readonly items = signal<Item[]>([]);
  readonly locations = signal<Loc[]>([]);
  private byId = computed(() => new Map(this.locations().map((l) => [l.id, l] as const)));
  readonly locationOptions = computed(() =>
    this.locations().map((l) => ({ id: l.id, label: this.pathOf(l.id) })),
  );

  // Form state is signal-backed (zoneless: a signal write is what refreshes the
  // view, including from async scan/lookup callbacks). Bind in the template with
  // [ngModel]="form().field" (ngModelChange)="patchX({ field: $event })".
  readonly place = signal<PlaceForm>(this.emptyPlace());
  readonly item = signal<ItemForm>(this.emptyItem());
  patchPlace(p: Partial<PlaceForm>): void {
    this.place.update((f) => ({ ...f, ...p }));
  }
  patchItem(p: Partial<ItemForm>): void {
    this.item.update((f) => ({ ...f, ...p }));
  }
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
    return { name: '', category: 'food', quantity: null, unit: null, expiry: null, location_id: null, barcode: null };
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

  private readonly imgFailed = signal<Set<number>>(new Set());
  imageUrl(it: Item): string | null {
    if (!it.barcode || this.imgFailed().has(it.id)) return null;
    return this.api.productImageUrl(it.barcode);
  }
  onImgError(id: number): void {
    this.imgFailed.update((s) => new Set(s).add(id));
  }

  /** The actionable tail of the location path (e.g. "Spice cupboard › Top shelf"). */
  shortLoc(id: number | null): string {
    if (id == null) return '';
    return this.pathOf(id).split(' › ').slice(-2).join(' › ');
  }

  addPlace(): void {
    if (!this.place().name.trim()) return;
    this.api.createLocation({ ...this.place() }).subscribe(() => {
      this.place.set(this.emptyPlace());
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
    if (!this.item().name.trim()) return;
    const body = { ...this.item() };
    const id = this.editingId();
    const req = id ? this.api.updateItem(id, body) : this.api.createItem(body);
    const barcode = this.item().barcode?.trim() || null;
    req.subscribe(() => {
      this.cancelEdit();
      // Cache the product image (if a barcode was set) before refreshing.
      if (barcode) {
        this.api.lookupProduct(barcode).subscribe({ next: () => this.reloadItems(), error: () => this.reloadItems() });
      } else {
        this.reloadItems();
      }
    });
  }

  editItem(it: Item): void {
    this.item.set({
      name: it.name,
      category: it.category,
      quantity: it.quantity,
      unit: it.unit,
      expiry: it.expiry,
      location_id: it.location_id,
      barcode: it.barcode,
    });
    this.editingId.set(it.id);
    this.showItemForm.set(true);
  }

  cancelEdit(): void {
    this.item.set(this.emptyItem());
    this.editingId.set(null);
  }

  /** Scan a barcode into the item form; look up to cache + prefill the name. */
  scan(): void {
    this.dialog
      .open<ScannerDialog, unknown, string | null>(ScannerDialog, { panelClass: 'scanner-pane' })
      .afterClosed()
      .subscribe((code) => {
        if (!code) return;
        this.patchItem({ barcode: code });
        this.api.lookupProduct(code).subscribe({
          next: (p) => {
            if (!this.item().name.trim() && p.name) this.patchItem({ name: p.name });
          },
          error: () => {},
        });
      });
  }

  deleteItem(id: number): void {
    this.api.deleteItem(id).subscribe(() => this.reloadItems());
  }
}
