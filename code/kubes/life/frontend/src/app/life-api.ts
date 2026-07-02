import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  ConflictEntry,
  ConflictKind,
  HouseScene,
  Item,
  Loc,
  Me,
  Product,
  Recipe,
  RecipeIngredient,
  ShoppingItem,
  TrashEntry,
  TrashKind,
} from './models';

/** Thin client over the life backend. Same-origin in prod; via the dev proxy
 *  (proxy.conf.json) in `ng serve`. Session cookie rides along automatically. */
@Injectable({ providedIn: 'root' })
export class LifeApi {
  private http = inject(HttpClient);

  me(): Observable<Me> {
    return this.http.get<Me>('/api/me');
  }
  logout(): Observable<unknown> {
    return this.http.post('/logout', {});
  }

  locations(): Observable<Loc[]> {
    return this.http.get<Loc[]>('/api/locations');
  }
  createLocation(body: Partial<Loc>): Observable<Loc> {
    return this.http.post<Loc>('/api/locations', body);
  }

  items(): Observable<Item[]> {
    return this.http.get<Item[]>('/api/items');
  }
  createItem(body: Partial<Item>): Observable<Item> {
    return this.http.post<Item>('/api/items', body);
  }
  updateItem(id: number, body: Partial<Item>): Observable<Item> {
    return this.http.patch<Item>(`/api/items/${id}`, body);
  }
  deleteItem(id: number): Observable<unknown> {
    return this.http.delete(`/api/items/${id}`);
  }
  moveItem(id: number, locationId: number | null): Observable<Item> {
    return this.http.post<Item>(`/api/items/${id}/move`, { location_id: locationId });
  }
  deleteLocation(id: number): Observable<unknown> {
    return this.http.delete(`/api/locations/${id}`);
  }

  house(): Observable<HouseScene> {
    return this.http.get<HouseScene>('/api/house');
  }

  shopping(): Observable<ShoppingItem[]> {
    return this.http.get<ShoppingItem[]>('/api/shopping');
  }
  addShopping(body: Partial<ShoppingItem>): Observable<ShoppingItem> {
    return this.http.post<ShoppingItem>('/api/shopping', body);
  }
  updateShopping(id: number, body: Partial<ShoppingItem>): Observable<ShoppingItem> {
    return this.http.patch<ShoppingItem>(`/api/shopping/${id}`, body);
  }
  deleteShopping(id: number): Observable<unknown> {
    return this.http.delete(`/api/shopping/${id}`);
  }
  buyShopping(id: number): Observable<Item> {
    return this.http.post<Item>(`/api/shopping/${id}/buy`, {});
  }

  /** Look up (and cache) a product by barcode via Open Food Facts. */
  lookupProduct(barcode: string): Observable<Product> {
    return this.http.get<Product>(`/api/products/${encodeURIComponent(barcode)}`);
  }
  /** URL of the cached product image (use directly as <img src>). Pass a
   *  `version` after a replace to bust the browser/service-worker cache. */
  productImageUrl(barcode: string, version?: number): string {
    const base = `/api/products/${encodeURIComponent(barcode)}/image`;
    return version ? `${base}?v=${version}` : base;
  }
  /** Replace the cached image for a barcode with raw image bytes. The blob's
   *  own mime rides along as Content-Type; the backend re-validates it. */
  uploadProductImage(barcode: string, blob: Blob): Observable<void> {
    return this.http.put<void>(`/api/products/${encodeURIComponent(barcode)}/image`, blob, {
      headers: { 'Content-Type': blob.type },
    });
  }

  /** Unresolved same-field sync conflicts, newest first. */
  conflicts(): Observable<ConflictEntry[]> {
    return this.http.get<ConflictEntry[]>('/api/conflicts');
  }
  /** Record a client-detected same-field conflict (values JSON-encoded). */
  reportConflict(body: {
    kind: ConflictKind;
    ulid: string;
    field: string;
    label: string;
    mine: string;
    theirs: string;
  }): Observable<void> {
    return this.http.post<void>('/api/conflicts', body);
  }
  /** Mark a conflict handled — keep-mine and use-other both end here. */
  resolveConflict(id: number): Observable<void> {
    return this.http.post<void>(`/api/conflicts/${id}/resolve`, {});
  }

  /** Everything deleted (all kinds), newest first. Nothing is ever purged. */
  trash(): Observable<TrashEntry[]> {
    return this.http.get<TrashEntry[]>('/api/trash');
  }
  /** Restore one trash entry — the deliberate undelete path (also used by the
   *  Undo snackbars). `ref` is the id (item/location/recipe) or ulid
   *  (shopping/todo) from the entry. */
  restoreTrash(kind: TrashKind, ref: string): Observable<void> {
    return this.http.post<void>(
      `/api/trash/${kind}/${encodeURIComponent(ref)}/restore`,
      {},
    );
  }

  recipes(): Observable<Recipe[]> {
    return this.http.get<Recipe[]>('/api/recipes');
  }
  createRecipe(body: Partial<Recipe>): Observable<Recipe> {
    return this.http.post<Recipe>('/api/recipes', body);
  }
  deleteRecipe(id: number): Observable<unknown> {
    return this.http.delete(`/api/recipes/${id}`);
  }
  cookable(): Observable<Recipe[]> {
    return this.http.get<Recipe[]>('/api/cookable');
  }
  shoppingList(id: number): Observable<RecipeIngredient[]> {
    return this.http.get<RecipeIngredient[]>(`/api/recipes/${id}/shopping-list`);
  }
}
