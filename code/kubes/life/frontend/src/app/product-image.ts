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
