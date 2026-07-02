import { HttpErrorResponse } from '@angular/common/http';
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
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, forkJoin, map, of, tap } from 'rxjs';

import { LifeApi } from '../../life-api';
import { ProductThumb } from '../../product-thumb';
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
    ProductThumb,
  ],
})
export class Shopping {
  private store = inject(ShoppingStore);
  private api = inject(LifeApi);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  // Local-first: the list is the live RxDB query — instant, offline, reactive.
  readonly items = toSignal(this.store.items$, { initialValue: [] as ShoppingDoc[] });
  readonly doneCount = computed(() => this.items().filter((i) => i.done).length);
  readonly syncError = this.store.syncError;

  // Form fields are signals: the app is zoneless, so a signal write (incl. from
  // an async scan/lookup callback) is what schedules the view refresh.
  readonly name = signal('');
  readonly quantity = signal<number | null>(null);
  readonly unit = signal<string | null>(null);
  readonly barcode = signal('');

  add(): void {
    if (!this.name().trim()) return;
    const barcode = this.barcode().trim() || null;
    const unit = this.unit()?.trim();
    // Optimistic, local — succeeds offline.
    void this.store.add({
      name: this.name().trim(),
      quantity: this.quantity(),
      unit: unit !== undefined && unit !== '' ? unit : null,
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

  /** True while a barcode lookup is in flight — dims the field's search icon. */
  readonly lookingUp = signal(false);

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
        this.snack.open(p.name ? `Found: ${p.name}` : 'Product found', undefined, { duration: 2500 });
      },
      error: (e: HttpErrorResponse) => {
        this.lookingUp.set(false);
        this.snack.open(
          e.status === 404 ? `No product found for ${code}.` : 'Lookup failed — are you online?',
          'OK',
          { duration: 4000 },
        );
      },
    });
  }

  toggle(it: ShoppingDoc): void {
    void this.store.setDone(it.ulid, !it.done);
  }

  remove(it: ShoppingDoc): void {
    void this.store.remove(it.ulid);
    this.undoableRemove([it]);
  }

  /** Offer Undo for removed rows. Two layers: revive locally right away (works
   *  offline), and — for rows the server has seen — also restore server-side,
   *  the authoritative undelete (a plain re-push can never clear a server
   *  tombstone). A restore 404 just means our delete push hadn't arrived yet;
   *  the revived local doc then pushes cleanly, so it's safe to ignore. */
  private undoableRemove(docs: ShoppingDoc[]): void {
    const what = docs.length === 1 ? `Removed “${docs[0].name}”` : `Removed ${docs.length} items`;
    this.snack
      .open(what, 'Undo', { duration: 6000 })
      .onAction()
      .subscribe(() => {
        for (const doc of docs) {
          void this.store.revive(doc);
          if (doc.id != null) {
            this.api.restoreTrash('shopping', doc.ulid).subscribe({
              next: () => this.store.reSync(),
              error: () => {}, // 404 = delete push never arrived; the revive covers it
            });
          }
        }
      });
  }

  /** Convert ticked-off rows into inventory items. Online-only (needs the
   *  inventory backend) and only for already-synced rows (those have a server
   *  id); the server soft-deletes them, which syncs back as a tombstone — we also
   *  remove locally for immediacy. Rows whose call fails STAY on the list (no
   *  silent local removal for something the server never inventoried), and the
   *  outcome is summarised either way. */
  buyDone(): void {
    const done = this.items().filter((i) => i.done && i.id != null);
    if (done.length === 0) return;
    const buys = done.map((it) =>
      this.api.buyShopping(it.id!).pipe(
        tap(() => void this.store.remove(it.ulid)), // remove as each one lands
        map(() => true),
        catchError(() => of(false)),
      ),
    );
    forkJoin(buys).subscribe((flags) => {
      const ok = flags.filter(Boolean).length;
      const failed = flags.length - ok;
      if (failed > 0) {
        this.snack.open(`${ok} added to inventory; ${failed} failed and stayed on the list.`, 'OK', {
          duration: 5000,
        });
      } else {
        this.snack.open(ok === 1 ? 'Added to inventory.' : `${ok} added to inventory.`, undefined, {
          duration: 2500,
        });
      }
    });
  }

  clearDone(): void {
    const cleared = this.items().filter((i) => i.done);
    void this.store.clearDone();
    if (cleared.length > 0) this.undoableRemove(cleared);
  }

  label(it: ShoppingDoc): string {
    if (it.quantity == null) return '';
    return it.unit ? `${it.quantity} ${it.unit}` : `${it.quantity}`;
  }
}
