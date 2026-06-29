import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'search' },
  {
    path: 'search',
    title: 'Life · find',
    loadComponent: () => import('./features/search/search').then((m) => m.Search),
  },
  {
    path: 'shopping',
    title: 'Life · buy',
    loadComponent: () => import('./features/shopping/shopping').then((m) => m.Shopping),
  },
  {
    path: 'inventory',
    title: 'Life · inventory',
    loadComponent: () => import('./features/inventory/inventory').then((m) => m.Inventory),
  },
  {
    path: 'recipes',
    title: 'Life · recipes',
    loadComponent: () => import('./features/recipes/recipes').then((m) => m.Recipes),
  },
  {
    path: 'house',
    title: 'Life · house',
    loadComponent: () => import('./features/house/house').then((m) => m.House),
  },
  { path: '**', redirectTo: 'search' },
];
