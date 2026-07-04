import { Routes } from '@angular/router';

import { History } from './features/history/history';
import { Overview } from './features/overview/overview';
import { Problems } from './features/problems/problems';
import { Report } from './features/report/report';

// Eager components (the fleet forbids lazy loadComponent). The app is four small
// views, so there's nothing to code-split.
export const routes: Routes = [
  { path: '', component: Overview, title: 'Fleetwatch — overview' },
  { path: 'problems', component: Problems, title: 'Fleetwatch — problems' },
  { path: 'reports/:id', component: Report, title: 'Fleetwatch — report' },
  { path: 'history', component: History, title: 'Fleetwatch — history' },
  { path: '**', redirectTo: '' },
];
