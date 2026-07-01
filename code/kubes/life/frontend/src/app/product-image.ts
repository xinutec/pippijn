import { Injectable, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { LifeApi } from './life-api';

/** Single source for "should this row show a product thumbnail?". Shopping,
 *  Inventory and All-items each track their own `imgFailed` set + render the
 *  <img>/icon (Material list slots differ), but the *rule* lives here so it
 *  can't drift between them — it did once, on the `has_image` check. */
export interface ThumbSource {
  barcode: string | null;
  /** From the catalog: a cached image exists. `undefined` (e.g. shopping rows,
   *  which don't carry it) = unknown → try anyway, the load-error fallback
   *  handles a miss. */
  has_image?: boolean;
}

export function showThumb(it: ThumbSource, failed: boolean): boolean {
  return !failed && !!it.barcode && it.has_image !== false;
}

/** Shared per-barcode cache-buster for product images. A cached image lives at a
 *  stable URL with a long `Cache-Control`, so after a replace the browser and
 *  service worker would keep serving the old bytes — bumping a version and
 *  appending it as `?v=` forces a reload. The map is app-wide, so replacing an
 *  image in one view refreshes it everywhere it's shown. */
@Injectable({ providedIn: 'root' })
export class ProductImages {
  private api = inject(LifeApi);
  private version = signal<ReadonlyMap<string, number>>(new Map());

  /** `<img src>` for a barcode's image, cache-busted after any replace. */
  url(barcode: string): string {
    return this.api.productImageUrl(barcode, this.version().get(barcode));
  }

  /** Upload new bytes; on success bump the buster so every `<img>` reloads. */
  replace(barcode: string, blob: Blob): Observable<void> {
    return this.api.uploadProductImage(barcode, blob).pipe(
      tap(() =>
        this.version.update((m) => new Map(m).set(barcode, (m.get(barcode) ?? 0) + 1)),
      ),
    );
  }
}
