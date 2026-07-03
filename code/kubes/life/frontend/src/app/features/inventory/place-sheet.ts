import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MAT_BOTTOM_SHEET_DATA,
  MatBottomSheetRef,
} from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { Feedback } from '../../shared/feedback';
import { SheetHeader } from '../../shared/sheet-header';
import { LifeApi } from '../../life-api';
import { LocationKind } from '../../models';

const KINDS: LocationKind[] = ['house', 'room', 'cupboard', 'fridge', 'layer'];

export interface PlaceSheetData {
  /** Parent-location options, already resolved by the parent screen. */
  locations: { id: number; label: string }[];
}

/** Register a storage place — bottom sheet. Dismisses with `true` after a
 *  successful create so the parent reloads. */
@Component({
  selector: 'app-place-sheet',
  templateUrl: './place-sheet.html',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    SheetHeader,
  ],
})
export class PlaceSheet {
  private ref = inject(MatBottomSheetRef<PlaceSheet, boolean>);
  private data = inject<PlaceSheetData>(MAT_BOTTOM_SHEET_DATA);
  private api = inject(LifeApi);
  private feedback = inject(Feedback);

  readonly kinds = KINDS;
  readonly locations = this.data.locations;
  readonly saving = signal(false);

  readonly name = signal('');
  readonly kind = signal<LocationKind>('cupboard');
  readonly parentId = signal<number | null>(null);

  save(): void {
    const name = this.name().trim();
    if (!name || this.saving()) return;
    this.saving.set(true);
    this.api.createLocation({ name, kind: this.kind(), parent_id: this.parentId() }).subscribe({
      next: () => this.ref.dismiss(true),
      error: (e: HttpErrorResponse) => {
        this.saving.set(false);
        const hint = e.status === 0 ? ' — are you online?' : '';
        this.feedback.error(`Could not add the place${hint}`);
      },
    });
  }

  close(): void {
    this.ref.dismiss();
  }
}
