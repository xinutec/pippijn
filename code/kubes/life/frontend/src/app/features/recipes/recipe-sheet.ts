import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

import { Feedback } from '../../shared/feedback';
import { SheetHeader } from '../../shared/sheet-header';
import { LifeApi } from '../../life-api';
import { RecipeIngredient } from '../../models';

interface RecipeForm {
  name: string;
  instructions: string | null;
  servings: number | null;
  ingredients: RecipeIngredient[];
}

/** New-recipe bottom sheet. Online-only (recipes are a server API); dismisses
 *  with `true` after a successful create so the parent reloads. */
@Component({
  selector: 'app-recipe-sheet',
  templateUrl: './recipe-sheet.html',
  styleUrl: './recipe-sheet.scss',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    SheetHeader,
  ],
})
export class RecipeSheet {
  private ref = inject(MatBottomSheetRef<RecipeSheet, boolean>);
  private api = inject(LifeApi);
  private feedback = inject(Feedback);

  readonly saving = signal(false);

  // Signal-backed form (zoneless: a signal write — incl. from the async create
  // callback — is what refreshes the view).
  readonly form = signal<RecipeForm>({
    name: '',
    instructions: null,
    servings: null,
    ingredients: [{ name: '', quantity: null, unit: null }],
  });

  patch(p: Partial<RecipeForm>): void {
    this.form.update((f) => ({ ...f, ...p }));
  }
  patchIngredient(i: number, p: Partial<RecipeIngredient>): void {
    this.form.update((f) => ({
      ...f,
      ingredients: f.ingredients.map((g, j) => (j === i ? { ...g, ...p } : g)),
    }));
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

  save(): void {
    const form = this.form();
    if (!form.name.trim() || this.saving()) return;
    this.saving.set(true);
    const body = { ...form, ingredients: form.ingredients.filter((g) => g.name.trim()) };
    this.api.createRecipe(body).subscribe({
      next: () => this.ref.dismiss(true),
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        const hint = e.status === 0 ? ' — are you online?' : '';
        this.feedback.error(`Could not save the recipe${hint}`);
      },
    });
  }

  close(): void {
    this.ref.dismiss();
  }
}
