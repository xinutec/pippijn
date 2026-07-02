import { Routes } from '@angular/router';

import { House } from './features/house/house';
import { Inventory } from './features/inventory/inventory';
import { Items } from './features/items/items';
import { Recipes } from './features/recipes/recipes';
import { Search } from './features/search/search';
import { Settings } from './features/settings/settings';
import { Shopping } from './features/shopping/shopping';
import { Todo } from './features/todo/todo';
import { Trash } from './features/trash/trash';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'search' },
  { path: 'search', title: 'Life · find', component: Search },
  { path: 'shopping', title: 'Life · buy', component: Shopping },
  { path: 'inventory', title: 'Life · inventory', component: Inventory },
  { path: 'recipes', title: 'Life · recipes', component: Recipes },
  { path: 'house', title: 'Life · house', component: House },
  { path: 'items', title: 'Life · all items', component: Items },
  { path: 'todo', title: 'Life · to-do', component: Todo },
  { path: 'trash', title: 'Life · recently deleted', component: Trash },
  { path: 'settings', title: 'Life · settings', component: Settings },
  { path: '**', redirectTo: 'search' },
];
