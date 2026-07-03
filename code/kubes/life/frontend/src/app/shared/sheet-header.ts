import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

/** The one header every bottom sheet carries: a title and a Close button.
 *  Keeps the sheet grammar identical across add/edit sheets. */
@Component({
  selector: 'app-sheet-header',
  templateUrl: './sheet-header.html',
  styleUrl: './sheet-header.scss',
  imports: [MatButtonModule, MatIconModule],
})
export class SheetHeader {
  readonly title = input.required<string>();
  readonly closed = output<void>();
}
