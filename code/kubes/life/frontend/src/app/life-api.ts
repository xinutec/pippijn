import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { HouseScene, Item, Loc, Me, Recipe, RecipeIngredient, SearchHit } from './models';

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
  moveItem(id: number, locationId: number | null): Observable<Item> {
    return this.http.post<Item>(`/api/items/${id}/move`, { location_id: locationId });
  }

  search(q: string): Observable<SearchHit[]> {
    return this.http.get<SearchHit[]>('/api/search', { params: { q } });
  }

  house(): Observable<HouseScene> {
    return this.http.get<HouseScene>('/api/house');
  }

  recipes(): Observable<Recipe[]> {
    return this.http.get<Recipe[]>('/api/recipes');
  }
  cookable(): Observable<Recipe[]> {
    return this.http.get<Recipe[]>('/api/cookable');
  }
  shoppingList(id: number): Observable<RecipeIngredient[]> {
    return this.http.get<RecipeIngredient[]>(`/api/recipes/${id}/shopping-list`);
  }
}
