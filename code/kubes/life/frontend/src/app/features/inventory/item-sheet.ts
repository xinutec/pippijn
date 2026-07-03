import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MAT_BOTTOM_SHEET_DATA,
  MatBottomSheetRef,
} from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { Feedback } from '../../shared/feedback';
import { SheetHeader } from '../../shared/sheet-header';
import { LifeApi } from '../../life-api';
import { Item, ItemCategory } from '../../models';
import { ScannerDialog } from '../scanner/scanner-dialog';

const CATEGORIES: ItemCategory[] = ['food', 'medication', 'tool', 'document', 'other'];

export interface ItemSheetData {
  /** Present = edit; absent = add. */
  item?: Item;
  /** Location dropdown options, already resolved by the parent. */
  locations: { id: number; label: string }[];
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

/** Add/edit an inventory item — the FAB's bottom sheet. Online-only (the
 *  inventory is a server API, not a sync store); dismisses with `true` after a
 *  successful save so the parent reloads. */
@Component({
  selector: 'app-item-sheet',
  templateUrl: './item-sheet.html',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    SheetHeader,
  ],
})
export class ItemSheet {
  private ref = inject(MatBottomSheetRef<ItemSheet, boolean>);
  private data = inject<ItemSheetData>(MAT_BOTTOM_SHEET_DATA);
  private api = inject(LifeApi);
  private dialog = inject(MatDialog);
  private feedback = inject(Feedback);

  readonly categories = CATEGORIES;
  readonly locations = this.data.locations;
  readonly editing = this.data.item != null;
  readonly saving = signal(false);

  readonly form = signal<ItemForm>(
    this.data.item
      ? {
          name: this.data.item.name,
          category: this.data.item.category,
          quantity: this.data.item.quantity,
          unit: this.data.item.unit,
          expiry: this.data.item.expiry,
          location_id: this.data.item.location_id,
          barcode: this.data.item.barcode,
        }
      : {
          name: '',
          category: 'food',
          quantity: null,
          unit: null,
          expiry: null,
          location_id: null,
          barcode: null,
        },
  );
  patch(p: Partial<ItemForm>): void {
    this.form.update((f) => ({ ...f, ...p }));
  }

  save(): void {
    if (!this.form().name.trim() || this.saving()) return;
    this.saving.set(true);
    const body = { ...this.form() };
    const id = this.data.item?.id;
    const req = id != null ? this.api.updateItem(id, body) : this.api.createItem(body);
    const trimmed = this.form().barcode?.trim();
    const barcode = trimmed !== undefined && trimmed !== '' ? trimmed : null;
    req.subscribe({
      next: () => {
        // Cache the product image (if a barcode was set) before the parent
        // refreshes — best-effort, the dismissal doesn't wait for it.
        if (barcode) this.api.lookupProduct(barcode).subscribe({ next: () => {}, error: () => {} });
        this.ref.dismiss(true);
      },
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        const hint = e.status === 0 ? ' — are you online?' : '';
        this.feedback.error(`Could not save the item${hint}`);
      },
    });
  }

  /** Scan a barcode into the form; look up to cache + prefill the name.
   *  Every outcome is announced — a scan that ends in silence reads as "the
   *  scanner is broken". */
  scan(): void {
    this.dialog
      .open<ScannerDialog, unknown, string | null>(ScannerDialog, {
        panelClass: 'scanner-pane',
        ariaLabel: 'Barcode scanner',
      })
      .afterClosed()
      .subscribe((code) => {
        if (!code) return;
        this.patch({ barcode: code });
        this.api.lookupProduct(code).subscribe({
          next: (p) => {
            if (!this.form().name.trim() && p.name) this.patch({ name: p.name });
            this.feedback.notify(p.name ? `Found: ${p.name}` : 'Product found');
          },
          error: (e: HttpErrorResponse) => {
            this.feedback.error(
              e.status === 404
                ? `No product found for ${code}.`
                : 'Lookup failed — are you online?',
            );
          },
        });
      });
  }

  close(): void {
    this.ref.dismiss();
  }
}
