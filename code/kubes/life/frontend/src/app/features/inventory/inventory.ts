import { HttpErrorResponse } from "@angular/common/http";
import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatDialog, MatDialogModule } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatListModule } from "@angular/material/list";
import { MatMenuModule } from "@angular/material/menu";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatSelectModule } from "@angular/material/select";
import { MatSnackBar } from "@angular/material/snack-bar";

import { revealAddForm } from "../../add-fab";
import { ExpiryInfo, expiryInfo } from "../../expiry";
import { LifeApi } from "../../life-api";
import { ProductThumb } from "../../product-thumb";
import { Item, ItemCategory, Loc, LocationKind } from "../../models";
import { ScannerDialog } from "../scanner/scanner-dialog";

const KINDS: LocationKind[] = ["house", "room", "cupboard", "fridge", "layer"];
const CATEGORIES: ItemCategory[] = [
  "food",
  "medication",
  "tool",
  "document",
  "other",
];

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
  selector: "app-inventory",
  templateUrl: "./inventory.html",
  styleUrl: "./inventory.scss",
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
    MatProgressBarModule,
    MatDialogModule,
    ProductThumb,
  ],
})
export class Inventory {
  private api = inject(LifeApi);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  /** Online-only writes must not fail into silence: announce and move on. */
  private failed(what: string) {
    return (e: HttpErrorResponse) => {
      const hint = e.status === 0 ? " — are you online?" : "";
      this.snack.open(`Could not ${what}${hint}`, "OK", { duration: 4000 });
    };
  }

  /** Deletes are tombstones (restorable from Recently deleted); offer an
   *  immediate Undo so a fat-finger costs one tap, not a trip to the trash. */
  private undoable(
    what: string,
    kind: "item" | "location",
    ref: number,
    reload: () => void,
  ) {
    this.snack
      .open(`${what} deleted`, "Undo", { duration: 6000 })
      .onAction()
      .subscribe(() => {
        this.api.restoreTrash(kind, String(ref)).subscribe({
          next: () => reload(),
          error: this.failed("undo the delete"),
        });
      });
  }

  readonly kinds = KINDS;
  readonly categories = CATEGORIES;

  readonly items = signal<Item[]>([]);
  readonly locations = signal<Loc[]>([]);
  /** Pre-fetch, empty lists mean "still loading", not "nothing yet". */
  readonly itemsLoaded = signal(false);
  readonly placesLoaded = signal(false);
  /** A load failure is not an empty inventory — show a retry, not "nothing yet". */
  readonly itemsError = signal(false);
  readonly placesError = signal(false);
  private byId = computed(
    () => new Map(this.locations().map((l) => [l.id, l] as const)),
  );
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
  /** The FAB's action: reveal the item form (the screen's primary add) and
   *  jump to it — it lives at the top of the scroll. */
  fabAddItem(): void {
    this.toggleItemForm();
    if (this.showItemForm()) revealAddForm();
  }
  togglePlaceForm(): void {
    this.showPlaceForm.update((v) => !v);
  }

  constructor() {
    this.reloadItems();
    this.reloadLocations();
  }

  reloadItems(): void {
    this.itemsError.set(false);
    this.api.items().subscribe({
      next: (i) => {
        this.items.set(i);
        this.itemsLoaded.set(true);
      },
      error: () => {
        this.itemsLoaded.set(true);
        this.itemsError.set(true);
      },
    });
  }
  reloadLocations(): void {
    this.placesError.set(false);
    this.api.locations().subscribe({
      next: (l) => {
        this.locations.set(l);
        this.placesLoaded.set(true);
      },
      error: () => {
        this.placesLoaded.set(true);
        this.placesError.set(true);
      },
    });
  }
  private emptyPlace(): PlaceForm {
    return { kind: "cupboard", name: "", parent_id: null };
  }
  private emptyItem(): ItemForm {
    return {
      name: "",
      category: "food",
      quantity: null,
      unit: null,
      expiry: null,
      location_id: null,
      barcode: null,
    };
  }

  /** Root→leaf breadcrumb for a location id, resolved client-side. */
  pathOf(id: number | null): string {
    if (id == null) return "";
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
    return names.join(" › ");
  }

  qty(item: Item): string {
    if (item.quantity == null) return "";
    return item.unit ? `${item.quantity} ${item.unit}` : `${item.quantity}`;
  }

  /** Urgency-aware expiry display (expired / soon / date). */
  expiryOf(expiry: string): ExpiryInfo {
    return expiryInfo(expiry);
  }

  /** The actionable tail of the location path (e.g. "Spice cupboard › Top shelf"). */
  shortLoc(id: number | null): string {
    if (id == null) return "";
    return this.pathOf(id).split(" › ").slice(-2).join(" › ");
  }

  addPlace(): void {
    if (!this.place().name.trim()) return;
    this.api.createLocation({ ...this.place() }).subscribe({
      next: () => {
        this.place.set(this.emptyPlace());
        this.reloadLocations();
      },
      error: this.failed("add the place"),
    });
  }

  deletePlace(id: number): void {
    this.api.deleteLocation(id).subscribe({
      next: () => {
        this.reloadLocations();
        this.reloadItems(); // items there read as unplaced until restored
        this.undoable("Place", "location", id, () => {
          this.reloadLocations();
          this.reloadItems();
        });
      },
      error: this.failed("delete the place"),
    });
  }

  saveItem(): void {
    if (!this.item().name.trim()) return;
    const body = { ...this.item() };
    const id = this.editingId();
    const req = id ? this.api.updateItem(id, body) : this.api.createItem(body);
    const trimmed = this.item().barcode?.trim();
    const barcode = trimmed !== undefined && trimmed !== "" ? trimmed : null;
    req.subscribe({
      next: () => {
        this.cancelEdit();
        // Cache the product image (if a barcode was set) before refreshing.
        if (barcode) {
          this.api
            .lookupProduct(barcode)
            .subscribe({
              next: () => this.reloadItems(),
              error: () => this.reloadItems(),
            });
        } else {
          this.reloadItems();
        }
      },
      error: this.failed("save the item"),
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
    revealAddForm(); // the form is at the top of the scroll — bring it into view
  }

  cancelEdit(): void {
    this.item.set(this.emptyItem());
    this.editingId.set(null);
  }

  /** Scan a barcode into the item form; look up to cache + prefill the name.
   *  Every outcome is announced — a scan that ends in silence reads as "the
   *  scanner is broken". */
  scan(): void {
    this.dialog
      .open<ScannerDialog, unknown, string | null>(ScannerDialog, {
        panelClass: "scanner-pane",
        ariaLabel: "Barcode scanner",
      })
      .afterClosed()
      .subscribe((code) => {
        if (!code) return;
        this.patchItem({ barcode: code });
        this.api.lookupProduct(code).subscribe({
          next: (p) => {
            if (!this.item().name.trim() && p.name)
              this.patchItem({ name: p.name });
            this.snack.open(
              p.name ? `Found: ${p.name}` : "Product found",
              undefined,
              { duration: 2500 },
            );
          },
          error: (e: HttpErrorResponse) => {
            this.snack.open(
              e.status === 404
                ? `No product found for ${code}.`
                : "Lookup failed — are you online?",
              "OK",
              { duration: 4000 },
            );
          },
        });
      });
  }

  deleteItem(id: number): void {
    this.api.deleteItem(id).subscribe({
      next: () => {
        this.reloadItems();
        this.undoable("Item", "item", id, () => this.reloadItems());
      },
      error: this.failed("delete the item"),
    });
  }
}
