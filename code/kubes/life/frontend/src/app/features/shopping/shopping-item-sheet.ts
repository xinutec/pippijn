import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
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

import { Feedback } from '../../shared/feedback';
import { SheetHeader } from '../../shared/sheet-header';
import { LifeApi } from '../../life-api';
import { ScannerDialog } from '../scanner/scanner-dialog';
import { ShoppingDoc, ShoppingStore } from '../../sync/shopping-store';

/** Add/edit one shopping row — the FAB's bottom sheet. Add mode stays open
 *  after each add (groceries are entered in bursts): clear, notify, refocus.
 *  Edit mode (data.ulid set) pre-fills and closes on Save. */
@Component({
  selector: 'app-shopping-item-sheet',
  templateUrl: './shopping-item-sheet.html',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    SheetHeader,
  ],
})
export class ShoppingItemSheet {
  private ref = inject(MatBottomSheetRef<ShoppingItemSheet>);
  private data = inject<{ ulid?: string } | null>(MAT_BOTTOM_SHEET_DATA, { optional: true });
  private store = inject(ShoppingStore);
  private api = inject(LifeApi);
  private dialog = inject(MatDialog);
  private feedback = inject(Feedback);

  private items = toSignal(this.store.items$, { initialValue: [] as ShoppingDoc[] });

  readonly ulid = this.data?.ulid ?? null;
  readonly editing = this.ulid != null;

  readonly name = signal('');
  readonly quantity = signal<number | null>(null);
  readonly unit = signal<string | null>(null);
  readonly barcode = signal('');
  readonly lookingUp = signal(false);

  constructor() {
    if (this.ulid) {
      const it = this.items().find((i) => i.ulid === this.ulid);
      if (it) {
        this.name.set(it.name);
        this.quantity.set(it.quantity);
        this.unit.set(it.unit);
        this.barcode.set(it.barcode ?? '');
      }
    }
  }

  save(): void {
    const name = this.name().trim();
    if (!name) return;
    const unit = this.unit()?.trim();
    const barcode = this.barcode().trim() || null;
    const fields = {
      name,
      quantity: this.quantity(),
      unit: unit !== undefined && unit !== '' ? unit : null,
      barcode,
    };
    // Best-effort online: warm the product (image) cache for the thumbnail.
    if (barcode) this.api.lookupProduct(barcode).subscribe({ next: () => {}, error: () => {} });

    if (this.ulid) {
      void this.store.patch(this.ulid, fields);
      this.ref.dismiss();
      return;
    }
    // Optimistic, local — succeeds offline. Stay open for the next item.
    void this.store.add(fields);
    this.feedback.notify(`Added ${name}`);
    this.name.set('');
    this.quantity.set(null);
    this.unit.set(null);
    this.barcode.set('');
    document.querySelector<HTMLElement>('app-shopping-item-sheet input')?.focus();
  }

  /** Open the camera scanner; on a detected code, fill the field and look up. */
  scan(): void {
    this.dialog
      .open<ScannerDialog, unknown, string | null>(ScannerDialog, {
        panelClass: 'scanner-pane',
        ariaLabel: 'Barcode scanner',
      })
      .afterClosed()
      .subscribe((code) => {
        if (code) {
          this.barcode.set(code);
          this.lookup();
        }
      });
  }

  /** Look up the typed barcode on Open Food Facts; prefill the name if empty.
   *  Every outcome is announced — a scan that ends in silence reads as "the
   *  scanner is broken". */
  lookup(): void {
    const code = this.barcode().trim();
    if (!code) return;
    this.lookingUp.set(true);
    this.api.lookupProduct(code).subscribe({
      next: (p) => {
        this.lookingUp.set(false);
        if (!this.name().trim() && p.name) this.name.set(p.name);
        this.feedback.notify(p.name ? `Found: ${p.name}` : 'Product found');
      },
      error: (e: HttpErrorResponse) => {
        this.lookingUp.set(false);
        this.feedback.error(
          e.status === 404 ? `No product found for ${code}.` : 'Lookup failed — are you online?',
        );
      },
    });
  }

  close(): void {
    this.ref.dismiss();
  }
}
