import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';

import { LifeApi } from '../../life-api';
import { showThumb } from '../../product-image';
import { ScannerDialog } from '../scanner/scanner-dialog';
import { ShoppingDoc, ShoppingStore } from '../../sync/shopping-store';

@Component({
  selector: 'app-shopping',
  templateUrl: './shopping.html',
  styleUrl: './shopping.scss',
  imports: [
    FormsModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatDialogModule,
  ],
})
export class Shopping {
  private store = inject(ShoppingStore);
  private api = inject(LifeApi);
  private dialog = inject(MatDialog);

  // Local-first: the list is the live RxDB query — instant, offline, reactive.
  readonly items = toSignal(this.store.items$, { initialValue: [] as ShoppingDoc[] });
  readonly doneCount = computed(() => this.items().filter((i) => i.done).length);
  readonly syncError = this.store.syncError;
  private readonly imgFailed = signal<Set<string>>(new Set());

  // Form fields are signals: the app is zoneless, so a signal write (incl. from
  // an async scan/lookup callback) is what schedules the view refresh.
  readonly name = signal('');
  readonly quantity = signal<number | null>(null);
  readonly unit = signal<string | null>(null);
  readonly barcode = signal('');

  add(): void {
    if (!this.name().trim()) return;
    const barcode = this.barcode().trim() || null;
    // Optimistic, local — succeeds offline.
    void this.store.add({
      name: this.name().trim(),
      quantity: this.quantity(),
      unit: this.unit()?.trim() || null,
      barcode,
    });
    // Best-effort online: warm the product (image) cache for the thumbnail.
    // Ignored offline; the row is already added locally.
    if (barcode) this.api.lookupProduct(barcode).subscribe({ next: () => {}, error: () => {} });
    this.name.set('');
    this.quantity.set(null);
    this.unit.set(null);
    this.barcode.set('');
  }

  /** Open the camera scanner; on a detected code, fill the field and look up. */
  scan(): void {
    this.dialog
      .open<ScannerDialog, unknown, string | null>(ScannerDialog, { panelClass: 'scanner-pane' })
      .afterClosed()
      .subscribe((code) => {
        if (code) {
          this.barcode.set(code);
          this.lookup();
        }
      });
  }

  /** Look up the typed barcode on Open Food Facts; prefill the name if empty. */
  lookup(): void {
    const code = this.barcode().trim();
    if (!code) return;
    this.api.lookupProduct(code).subscribe({
      next: (p) => {
        if (!this.name().trim() && p.name) this.name.set(p.name);
      },
      error: () => {},
    });
  }

  toggle(it: ShoppingDoc): void {
    void this.store.setDone(it.ulid, !it.done);
  }

  remove(key: string): void {
    void this.store.remove(key);
  }

  /** Convert ticked-off rows into inventory items. Online-only (needs the
   *  inventory backend) and only for already-synced rows (those have a server
   *  id); the server soft-deletes them, which syncs back as a tombstone — we also
   *  remove locally for immediacy. */
  buyDone(): void {
    for (const it of this.items().filter((i) => i.done && i.id != null)) {
      this.api.buyShopping(it.id as number).subscribe({
        next: () => void this.store.remove(it.ulid),
        error: () => {},
      });
    }
  }

  clearDone(): void {
    void this.store.clearDone();
  }

  /** Thumbnail URL for an item with a barcode, unless the image failed to load. */
  imageUrl(it: ShoppingDoc): string | null {
    return showThumb(it, this.imgFailed().has(it.ulid)) ? this.api.productImageUrl(it.barcode!) : null;
  }
  onImgError(key: string): void {
    this.imgFailed.update((s) => new Set(s).add(key));
  }

  label(it: ShoppingDoc): string {
    if (it.quantity == null) return '';
    return it.unit ? `${it.quantity} ${it.unit}` : `${it.quantity}`;
  }
}
