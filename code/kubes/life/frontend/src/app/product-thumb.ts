import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';

import { ImagePickerDirective } from './image-picker';
import { ProductImages, showThumb } from './product-image';

/** The native clipboard bridge the Android WebView wrapper injects (see the app's
 *  MainActivity). Present only inside the custom app; absent in a browser. */
interface AndroidClipboard {
  /** A `data:` URL of the image on the system clipboard, or null if none. */
  readImage(): string | null;
}
function androidClipboard(): AndroidClipboard | undefined {
  const bridge = (globalThis as { AndroidClipboard?: AndroidClipboard }).AndroidClipboard;
  return typeof bridge?.readImage === 'function' ? bridge : undefined;
}

/** Client ceiling, mirrors the backend's 5 MiB cap. */
const MAX_BYTES = 5 * 1024 * 1024;

/** A product thumbnail that doubles as a one-tap image picker (see
 *  [[ImagePickerDirective]]). Drop it into any list row:
 *
 *      <app-product-thumb matListItemAvatar [barcode]="it.barcode"
 *                         [hasImage]="it.has_image" />
 *
 *  It renders the cached image, or an `add_a_photo` placeholder when the barcoded
 *  product has none, and owns the whole replace flow (pick → upload → reload) so
 *  the host list doesn't have to. Inside the Android app it also offers "Paste
 *  copied image" (from the system clipboard, e.g. an image copied in Chrome).
 *  Items without a barcode get a plain, inert icon — there's no catalog row to
 *  attach an image to. */
@Component({
  selector: 'app-product-thumb',
  templateUrl: './product-thumb.html',
  styleUrl: './product-thumb.scss',
  imports: [MatIconModule, MatMenuModule, NgTemplateOutlet, ImagePickerDirective],
})
export class ProductThumb {
  readonly barcode = input<string | null>(null);
  /** Catalog hint: does a cached image exist? `undefined` = unknown, try anyway. */
  readonly hasImage = input<boolean | undefined>(undefined);

  private images = inject(ProductImages);
  private snack = inject(MatSnackBar);

  /** True in the custom Android app (the clipboard bridge is present) — there we
   *  offer a menu (Paste / Choose); in a browser, tapping picks a file directly. */
  protected readonly inApp = androidClipboard() !== undefined;

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
        this.snack.open('Could not save the image.', 'OK', { duration: 4000 });
      },
    });
  }

  protected onPickError(message: string): void {
    this.snack.open(message, 'OK', { duration: 4000 });
  }

  /** Upload the image currently on the system clipboard (Android app only). */
  protected async pasteFromClipboard(): Promise<void> {
    const dataUrl = androidClipboard()?.readImage() ?? null;
    if (!dataUrl) {
      this.snack.open('No image on the clipboard — use “Copy image” first.', 'OK', {
        duration: 4000,
      });
      return;
    }
    const blob = await (await fetch(dataUrl)).blob();
    if (blob.size > MAX_BYTES) {
      this.snack.open('That image is larger than 5 MB.', 'OK', { duration: 4000 });
      return;
    }
    this.onPicked(blob);
  }
}
