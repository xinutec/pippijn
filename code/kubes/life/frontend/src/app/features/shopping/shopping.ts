import { Component, computed, inject } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { MatBottomSheet, MatBottomSheetModule } from "@angular/material/bottom-sheet";
import { MatButtonModule } from "@angular/material/button";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatIconModule } from "@angular/material/icon";
import { MatListModule } from "@angular/material/list";
import { catchError, forkJoin, map, of, tap } from "rxjs";

import { Feedback } from "../../shared/feedback";
import { ListState } from "../../shared/list-state";
import { LifeApi } from "../../life-api";
import { ProductThumb } from "../../product-thumb";
import { ShoppingDoc, ShoppingStore } from "../../sync/shopping-store";
import { ShoppingItemSheet } from "./shopping-item-sheet";

@Component({
  selector: "app-shopping",
  templateUrl: "./shopping.html",
  styleUrl: "./shopping.scss",
  imports: [
    MatBottomSheetModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatCheckboxModule,
    ProductThumb,
    ListState,
  ],
})
export class Shopping {
  private store = inject(ShoppingStore);
  private api = inject(LifeApi);
  private sheet = inject(MatBottomSheet);
  private feedback = inject(Feedback);

  // Local-first: the list is the live RxDB query — instant, offline, reactive.
  readonly items = toSignal(this.store.items$, {
    initialValue: [] as ShoppingDoc[],
  });
  /** False until the local DB has produced its first result — so a cold start
   *  shows a spinner, not a flash of "nothing on the list". */
  readonly loaded = toSignal(this.store.items$.pipe(map(() => true)), {
    initialValue: false,
  });
  readonly doneCount = computed(
    () => this.items().filter((i) => i.done).length,
  );
  readonly syncError = this.store.syncError;

  /** The FAB's action: the add sheet (stays open for burst entry). */
  openAdd(): void {
    this.sheet.open(ShoppingItemSheet);
  }

  /** Tap a row title: the same sheet, pre-filled. */
  edit(it: ShoppingDoc): void {
    this.sheet.open(ShoppingItemSheet, { data: { ulid: it.ulid } });
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
    const what =
      docs.length === 1
        ? `Removed “${docs[0].name}”`
        : `Removed ${docs.length} items`;
    this.feedback.undo(what, () => {
      for (const doc of docs) {
        void this.store.revive(doc);
        if (doc.id != null) {
          this.api.restoreTrash("shopping", doc.ulid).subscribe({
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
        this.feedback.error(
          `${ok} added to inventory; ${failed} failed and stayed on the list.`,
        );
      } else {
        this.feedback.notify(
          ok === 1 ? "Added to inventory." : `${ok} added to inventory.`,
        );
      }
    });
  }

  clearDone(): void {
    const cleared = this.items().filter((i) => i.done);
    void this.store.clearDone();
    if (cleared.length > 0) this.undoableRemove(cleared);
  }

  label(it: ShoppingDoc): string {
    if (it.quantity == null) return "";
    return it.unit ? `${it.quantity} ${it.unit}` : `${it.quantity}`;
  }
}
