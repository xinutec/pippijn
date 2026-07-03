import { HttpErrorResponse } from "@angular/common/http";
import { Component, computed, inject, signal } from "@angular/core";
import { MatBottomSheet, MatBottomSheetModule } from "@angular/material/bottom-sheet";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatListModule } from "@angular/material/list";
import { MatMenuModule } from "@angular/material/menu";

import { Feedback } from "../../shared/feedback";
import { ListState } from "../../shared/list-state";
import { ExpiryInfo, expiryInfo } from "../../expiry";
import { LifeApi } from "../../life-api";
import { ProductThumb } from "../../product-thumb";
import { Item, Loc } from "../../models";
import { ItemSheet, ItemSheetData } from "./item-sheet";
import { PlaceSheet, PlaceSheetData } from "./place-sheet";

@Component({
  selector: "app-inventory",
  templateUrl: "./inventory.html",
  styleUrl: "./inventory.scss",
  imports: [
    MatBottomSheetModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatMenuModule,
    ProductThumb,
    ListState,
  ],
})
export class Inventory {
  private api = inject(LifeApi);
  private sheet = inject(MatBottomSheet);
  private feedback = inject(Feedback);

  /** Online-only writes must not fail into silence: announce and move on. */
  private failed(what: string) {
    return (e: HttpErrorResponse) => {
      const hint = e.status === 0 ? " — are you online?" : "";
      this.feedback.error(`Could not ${what}${hint}`);
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
    this.feedback.undo(`${what} deleted`, () => {
      this.api.restoreTrash(kind, String(ref)).subscribe({
        next: () => reload(),
        error: this.failed("undo the delete"),
      });
    });
  }

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

  constructor() {
    this.reloadItems();
    this.reloadLocations();
  }

  /** The FAB's action: the add-item sheet. */
  addItem(): void {
    this.openItemSheet({ locations: this.locationOptions() });
  }

  editItem(it: Item): void {
    this.openItemSheet({ item: it, locations: this.locationOptions() });
  }

  private openItemSheet(data: ItemSheetData): void {
    this.sheet
      .open<ItemSheet, ItemSheetData, boolean>(ItemSheet, { data })
      .afterDismissed()
      .subscribe((saved) => {
        if (saved) this.reloadItems();
      });
  }

  addPlace(): void {
    const data: PlaceSheetData = { locations: this.locationOptions() };
    this.sheet
      .open<PlaceSheet, PlaceSheetData, boolean>(PlaceSheet, { data })
      .afterDismissed()
      .subscribe((saved) => {
        if (saved) this.reloadLocations();
      });
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
