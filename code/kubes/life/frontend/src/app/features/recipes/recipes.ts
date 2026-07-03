import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { MatBottomSheet, MatBottomSheetModule } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';

import { Feedback } from '../../shared/feedback';
import { ListState } from '../../shared/list-state';
import { LifeApi } from '../../life-api';
import { Recipe, RecipeIngredient } from '../../models';
import { RecipeSheet } from './recipe-sheet';

@Component({
  selector: 'app-recipes',
  templateUrl: './recipes.html',
  styleUrl: './recipes.scss',
  imports: [
    MatBottomSheetModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    ListState,
  ],
})
export class Recipes {
  private api = inject(LifeApi);
  private sheet = inject(MatBottomSheet);
  private feedback = inject(Feedback);

  /** Online-only writes must not fail into silence: announce and move on. */
  private failed(what: string) {
    return (e: HttpErrorResponse) => {
      const hint = e.status === 0 ? ' — are you online?' : '';
      this.feedback.error(`Could not ${what}${hint}`);
    };
  }

  readonly recipes = signal<Recipe[]>([]);
  /** Pre-fetch, an empty list means "still loading", not "no recipes". */
  readonly loaded = signal(false);
  /** A load failure is not "no recipes" — show a retry. */
  readonly loadError = signal(false);
  readonly cookableIds = signal<Set<number>>(new Set());
  readonly shopping = signal<Map<number, RecipeIngredient[]>>(new Map());

  readonly cookableCount = computed(() => this.cookableIds().size);

  /** The FAB's action: the new-recipe sheet; reload after a save. */
  addRecipe(): void {
    this.sheet
      .open<RecipeSheet, undefined, boolean>(RecipeSheet)
      .afterDismissed()
      .subscribe((saved) => {
        if (saved) this.reload();
      });
  }

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loadError.set(false);
    this.api.recipes().subscribe({
      next: (r) => {
        this.recipes.set(r);
        this.loaded.set(true);
      },
      error: () => {
        this.loaded.set(true);
        this.loadError.set(true);
      },
    });
    this.api.cookable().subscribe((r) => this.cookableIds.set(new Set(r.map((x) => x.id))));
  }

  deleteRecipe(id: number): void {
    this.api.deleteRecipe(id).subscribe({
      next: () => {
        this.reload();
        // Deletes are tombstones (restorable from Recently deleted); offer an
        // immediate Undo so a fat-finger costs one tap.
        this.feedback.undo('Recipe deleted', () => {
          this.api.restoreTrash('recipe', String(id)).subscribe({
            next: () => this.reload(),
            error: this.failed('undo the delete'),
          });
        });
      },
      error: this.failed('delete the recipe'),
    });
  }

  isCookable(id: number): boolean {
    return this.cookableIds().has(id);
  }

  loadShoppingList(id: number): void {
    this.api.shoppingList(id).subscribe({
      next: (list) => {
        const next = new Map(this.shopping());
        next.set(id, list);
        this.shopping.set(next);
      },
      error: this.failed('load the shopping list'),
    });
  }

  shoppingFor(id: number): RecipeIngredient[] | undefined {
    return this.shopping().get(id);
  }

  label(ing: RecipeIngredient): string {
    const amount = ing.quantity != null ? `${ing.quantity}${ing.unit ? ' ' + ing.unit : ''} ` : '';
    return `${amount}${ing.name}`;
  }
}
