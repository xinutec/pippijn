import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';

import { LifeApi } from '../../life-api';
import { Recipe, RecipeIngredient } from '../../models';

interface RecipeForm {
  name: string;
  instructions: string | null;
  servings: number | null;
  ingredients: RecipeIngredient[];
}

@Component({
  selector: 'app-recipes',
  templateUrl: './recipes.html',
  styleUrl: './recipes.scss',
  imports: [
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
  ],
})
export class Recipes {
  private api = inject(LifeApi);
  private snack = inject(MatSnackBar);

  /** Online-only writes must not fail into silence: announce and move on. */
  private failed(what: string) {
    return (e: HttpErrorResponse) => {
      const hint = e.status === 0 ? ' — are you online?' : '';
      this.snack.open(`Could not ${what}${hint}`, 'OK', { duration: 4000 });
    };
  }

  readonly recipes = signal<Recipe[]>([]);
  readonly cookableIds = signal<Set<number>>(new Set());
  readonly shopping = signal<Map<number, RecipeIngredient[]>>(new Map());

  readonly cookableCount = computed(() => this.cookableIds().size);

  // Signal-backed form (zoneless: a signal write — incl. the reset inside the
  // async create callback — is what refreshes the view).
  readonly form = signal<RecipeForm>(this.emptyForm());
  readonly showForm = signal(false);

  patchForm(p: Partial<RecipeForm>): void {
    this.form.update((f) => ({ ...f, ...p }));
  }
  patchIngredient(i: number, p: Partial<RecipeIngredient>): void {
    this.form.update((f) => ({
      ...f,
      ingredients: f.ingredients.map((g, j) => (j === i ? { ...g, ...p } : g)),
    }));
  }

  toggleForm(): void {
    this.showForm.update((v) => !v);
  }

  constructor() {
    this.reload();
  }

  private reload(): void {
    this.api.recipes().subscribe((r) => this.recipes.set(r));
    this.api.cookable().subscribe((r) => this.cookableIds.set(new Set(r.map((x) => x.id))));
  }

  private emptyForm(): RecipeForm {
    return { name: '', instructions: null, servings: null, ingredients: [{ name: '', quantity: null, unit: null }] };
  }

  addIngredientRow(): void {
    this.form.update((f) => ({
      ...f,
      ingredients: [...f.ingredients, { name: '', quantity: null, unit: null }],
    }));
  }

  removeIngredientRow(i: number): void {
    this.form.update((f) => ({ ...f, ingredients: f.ingredients.filter((_, j) => j !== i) }));
  }

  createRecipe(): void {
    const form = this.form();
    if (!form.name.trim()) return;
    const body = {
      ...form,
      ingredients: form.ingredients.filter((g) => g.name.trim()),
    };
    this.api.createRecipe(body).subscribe({
      next: () => {
        this.form.set(this.emptyForm());
        this.showForm.set(false);
        this.reload();
      },
      error: this.failed('save the recipe'),
    });
  }

  deleteRecipe(id: number): void {
    this.api.deleteRecipe(id).subscribe({
      next: () => this.reload(),
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
