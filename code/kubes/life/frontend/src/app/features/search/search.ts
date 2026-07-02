import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';

import { LifeApi } from '../../life-api';
import { Loc, SearchHit } from '../../models';

@Component({
  selector: 'app-search',
  templateUrl: './search.html',
  styleUrl: './search.scss',
  imports: [
    FormsModule,
    RouterLink,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatButtonModule,
    MatCardModule,
  ],
})
export class Search {
  private api = inject(LifeApi);
  private snack = inject(MatSnackBar);

  query = '';
  readonly hits = signal<SearchHit[]>([]);
  readonly searched = signal(false);

  run(): void {
    const q = this.query.trim();
    if (!q) {
      this.hits.set([]);
      this.searched.set(false);
      return;
    }
    this.api.search(q).subscribe({
      next: (h) => {
        this.hits.set(h);
        this.searched.set(true);
      },
      error: () => this.snack.open('Search failed — are you online?', 'OK', { duration: 4000 }),
    });
  }

  /** Root→leaf breadcrumb of where an item lives. */
  breadcrumb(path: Loc[]): string {
    return path.map((l) => l.name).join(' › ');
  }
}
