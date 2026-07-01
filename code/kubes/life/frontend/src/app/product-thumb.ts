import { Component, computed, inject, input, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';

import { ImagePickerDirective } from './image-picker';
import { ProductImages, showThumb } from './product-image';

/** A product thumbnail that doubles as a one-tap image picker (see
 *  [[ImagePickerDirective]]). Drop it into any list row:
 *
 *      <app-product-thumb matListItemAvatar [barcode]="it.barcode"
 *                         [hasImage]="it.has_image" />
 *
 *  It renders the cached image, or an `add_a_photo` placeholder when the barcoded
 *  product has none, and owns the whole replace flow (pick → upload → reload) so
 *  the host list doesn't have to. Items without a barcode get a plain, inert icon
 *  — there's no catalog row to attach an image to. */
@Component({
  selector: 'app-product-thumb',
  templateUrl: './product-thumb.html',
  styleUrl: './product-thumb.scss',
  imports: [MatIconModule, ImagePickerDirective],
})
export class ProductThumb {
  readonly barcode = input<string | null>(null);
  /** Catalog hint: does a cached image exist? `undefined` = unknown, try anyway. */
  readonly hasImage = input<boolean | undefined>(undefined);

  private images = inject(ProductImages);
  private snack = inject(MatSnackBar);

  private failed = signal(false);
  /** Set once a replace succeeds, so the image shows even if `hasImage` was false. */
  private uploaded = signal(false);
  protected readonly busy = signal(false);

  /** The image URL to show, or null to fall back to the placeholder icon. */
  protected readonly src = computed<string | null>(() => {
    const barcode = this.barcode();
    if (!barcode) return null;
    if (this.uploaded()) return this.images.url(barcode);
    if (!showThumb({ barcode, has_image: this.hasImage() }, this.failed())) return null;
    return this.images.url(barcode);
  });

  protected onError(): void {
    this.failed.set(true);
  }

  protected onPicked(blob: Blob): void {
    const barcode = this.barcode();
    if (!barcode) return;
    this.busy.set(true);
    this.images.replace(barcode, blob).subscribe({
      next: () => {
        this.failed.set(false);
        this.uploaded.set(true);
        this.busy.set(false);
      },
      error: () => {
        this.busy.set(false);
        this.snack.open('Could not save the image.', 'Dismiss', { duration: 4000 });
      },
    });
  }

  protected onPickError(message: string): void {
    this.snack.open(message, 'Dismiss', { duration: 4000 });
  }
}
