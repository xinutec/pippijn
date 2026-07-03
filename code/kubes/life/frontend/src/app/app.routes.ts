import { Routes } from '@angular/router';

import { Conflicts } from './features/conflicts/conflicts';
import { House } from './features/house/house';
import { Inventory } from './features/inventory/inventory';
import { Items } from './features/items/items';
import { Recipes } from './features/recipes/recipes';
import { Settings } from './features/settings/settings';
import { Shopping } from './features/shopping/shopping';
import { Todo } from './features/todo/todo';
import { Today } from './features/today/today';
import { Trash } from './features/trash/trash';
import { Wellbeing } from './features/wellbeing/wellbeing';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'today' },
  { path: 'today', title: 'Life · today', component: Today },
  { path: 'shopping', title: 'Life · buy', component: Shopping },
  { path: 'inventory', title: 'Life · inventory', component: Inventory },
  { path: 'recipes', title: 'Life · recipes', component: Recipes },
  { path: 'house', title: 'Life · house', component: House },
  { path: 'items', title: 'Life · all items', component: Items },
  { path: 'todo', title: 'Life · to-do', component: Todo },
  { path: 'wellbeing', title: 'Life · wellbeing', component: Wellbeing },
  { path: 'trash', title: 'Life · recently deleted', component: Trash },
  { path: 'conflicts', title: 'Life · sync conflicts', component: Conflicts },
  { path: 'settings', title: 'Life · settings', component: Settings },
  { path: '**', redirectTo: 'today' },
];
