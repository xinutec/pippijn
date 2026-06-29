import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';

import { LifeApi } from '../../life-api';
import { ShoppingItem } from '../../models';
import { ScannerDialog } from '../scanner/scanner-dialog';

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
  private api = inject(LifeApi);
  private dialog = inject(MatDialog);

  readonly items = signal<ShoppingItem[]>([]);
  readonly doneCount = computed(() => this.items().filter((i) => i.done).length);
  private readonly imgFailed = signal<Set<number>>(new Set());

  name = '';
  quantity: number | null = null;
  unit: string | null = null;
  barcode = '';

  constructor() {
    this.reload();
  }

  private reload(): void {
    this.api.shopping().subscribe((i) => this.items.set(i));
  }

  add(): void {
    if (!this.name.trim()) return;
    const barcode = this.barcode.trim() || null;
    this.api.addShopping({ name: this.name, quantity: this.quantity, unit: this.unit, barcode }).subscribe(() => {
      this.name = '';
      this.quantity = null;
      this.unit = null;
      this.barcode = '';
      // Ensure the product (and its image) is cached, then refresh so the
      // thumbnail shows. No-op if there's no barcode.
      if (barcode) {
        this.api.lookupProduct(barcode).subscribe({ next: () => this.reload(), error: () => this.reload() });
      } else {
        this.reload();
      }
    });
  }

  /** Open the camera scanner; on a detected code, fill the field and look up. */
  scan(): void {
    this.dialog
      .open<ScannerDialog, unknown, string | null>(ScannerDialog, { panelClass: 'scanner-pane' })
      .afterClosed()
      .subscribe((code) => {
        if (code) {
          this.barcode = code;
          this.lookup();
        }
      });
  }

  /** Look up the typed barcode on Open Food Facts; prefill the name if empty. */
  lookup(): void {
    const code = this.barcode.trim();
    if (!code) return;
    this.api.lookupProduct(code).subscribe({
      next: (p) => {
        if (!this.name.trim() && p.name) this.name = p.name;
      },
      error: () => {},
    });
  }

  toggle(it: ShoppingItem): void {
    this.api
      .updateShopping(it.id, {
        name: it.name,
        quantity: it.quantity,
        unit: it.unit,
        barcode: it.barcode,
        done: !it.done,
      })
      .subscribe(() => this.reload());
  }

  remove(id: number): void {
    this.api.deleteShopping(id).subscribe(() => this.reload());
  }

  buyDone(): void {
    const done = this.items().filter((i) => i.done);
    if (!done.length) return;
    forkJoin(done.map((i) => this.api.buyShopping(i.id))).subscribe(() => this.reload());
  }

  clearDone(): void {
    const done = this.items().filter((i) => i.done);
    if (!done.length) return;
    forkJoin(done.map((i) => this.api.deleteShopping(i.id))).subscribe(() => this.reload());
  }

  /** Thumbnail URL for an item with a barcode, unless the image failed to load. */
  imageUrl(it: ShoppingItem): string | null {
    if (!it.barcode || this.imgFailed().has(it.id)) return null;
    return this.api.productImageUrl(it.barcode);
  }
  onImgError(id: number): void {
    this.imgFailed.update((s) => new Set(s).add(id));
  }

  label(it: ShoppingItem): string {
    if (it.quantity == null) return '';
    return it.unit ? `${it.quantity} ${it.unit}` : `${it.quantity}`;
  }
}
