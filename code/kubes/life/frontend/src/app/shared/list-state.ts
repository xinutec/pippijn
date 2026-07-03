import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

/** The loading / error / empty triad every list screen shows before its data.
 *  One place for the spinner, the retry-on-error line and the empty-state line,
 *  so the list screens stop each re-inventing (and mis-styling) them.
 *
 *  It renders ONLY the status line — the list itself stays in the host template
 *  and is naturally empty while data is loading or absent. Place it above the
 *  list:
 *
 *    <app-list-state [loading]="!loaded()" [empty]="items().length === 0"
 *                    emptyText="No items yet." emptyIcon="inventory_2" />
 *    <mat-list> … </mat-list>
 *
 *  HTTP-backed screens that can fail to load pass [error] and handle (retry);
 *  RxDB-backed screens (which can't fail to load) omit both. */
@Component({
  selector: 'app-list-state',
  templateUrl: './list-state.html',
  styleUrl: './list-state.scss',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule],
})
export class ListState {
  /** Data hasn't produced its first result yet → spinner. */
  readonly loading = input(false);
  /** The load failed (not the same as "empty") → message + Retry. */
  readonly error = input(false);
  /** Loaded successfully but there's nothing to show → empty message. */
  readonly empty = input(false);

  readonly emptyText = input('Nothing here yet.');
  /** Optional Material icon name shown above the empty message. */
  readonly emptyIcon = input<string | null>(null);
  readonly errorText = input('Couldn’t load — are you online?');

  /** Emitted when the user taps Retry in the error state. */
  readonly retry = output<void>();
}
