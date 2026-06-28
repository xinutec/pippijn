import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'search' },
  {
    path: 'search',
    title: 'life · find',
    loadComponent: () => import('./features/search/search').then((m) => m.Search),
  },
  {
    path: 'inventory',
    title: 'life · inventory',
    loadComponent: () => import('./features/inventory/inventory').then((m) => m.Inventory),
  },
  {
    path: 'recipes',
    title: 'life · recipes',
    loadComponent: () => import('./features/recipes/recipes').then((m) => m.Recipes),
  },
  {
    path: 'house',
    title: 'life · house',
    loadComponent: () => import('./features/house/house').then((m) => m.House),
  },
  { path: '**', redirectTo: 'search' },
];
