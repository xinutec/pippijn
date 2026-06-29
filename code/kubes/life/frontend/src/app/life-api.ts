import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  HouseScene,
  Item,
  Loc,
  Me,
  Recipe,
  RecipeIngredient,
  SearchHit,
  ShoppingItem,
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

  search(q: string): Observable<SearchHit[]> {
    return this.http.get<SearchHit[]>('/api/search', { params: { q } });
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
