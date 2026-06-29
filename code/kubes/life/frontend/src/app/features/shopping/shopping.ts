import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';

import { LifeApi } from '../../life-api';
import { ShoppingItem } from '../../models';

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
  ],
})
export class Shopping {
  private api = inject(LifeApi);

  readonly items = signal<ShoppingItem[]>([]);
  readonly doneCount = computed(() => this.items().filter((i) => i.done).length);

  name = '';
  quantity: number | null = null;
  unit: string | null = null;

  constructor() {
    this.reload();
  }

  private reload(): void {
    this.api.shopping().subscribe((i) => this.items.set(i));
  }

  add(): void {
    if (!this.name.trim()) return;
    this.api.addShopping({ name: this.name, quantity: this.quantity, unit: this.unit }).subscribe(() => {
      this.name = '';
      this.quantity = null;
      this.unit = null;
      this.reload();
    });
  }

  toggle(it: ShoppingItem): void {
    this.api
      .updateShopping(it.id, { name: it.name, quantity: it.quantity, unit: it.unit, done: !it.done })
      .subscribe(() => this.reload());
  }

  remove(id: number): void {
    this.api.deleteShopping(id).subscribe(() => this.reload());
  }

  /** Turn everything ticked off into inventory items (then drop from the list). */
  buyDone(): void {
    const done = this.items().filter((i) => i.done);
    if (!done.length) return;
    forkJoin(done.map((i) => this.api.buyShopping(i.id))).subscribe(() => this.reload());
  }

  /** Just remove the ticked-off items (don't add to inventory). */
  clearDone(): void {
    const done = this.items().filter((i) => i.done);
    if (!done.length) return;
    forkJoin(done.map((i) => this.api.deleteShopping(i.id))).subscribe(() => this.reload());
  }

  label(it: ShoppingItem): string {
    if (it.quantity == null) return '';
    return it.unit ? `${it.quantity} ${it.unit}` : `${it.quantity}`;
  }
}
