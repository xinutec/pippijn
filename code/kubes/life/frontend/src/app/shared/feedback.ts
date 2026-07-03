import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

/** The app's snackbar grammar in one place, so every screen speaks the same way
 *  instead of each re-typing `snack.open(...)` with drifting copy and durations.
 *
 *  - `error()`  — a consistent failure notice (uniform fallback copy + duration).
 *  - `notify()` — a brief neutral confirmation ("Added to inventory.").
 *  - `undo()`   — the "Deleted X — Undo" safety net; commits the deletion when
 *                 the bar dismisses without an Undo tap. Generalised from the
 *                 to-do / shopping delete flow so any screen offers the same net. */
@Injectable({ providedIn: 'root' })
export class Feedback {
  private snack = inject(MatSnackBar);

  /** A failure notice. Most call sites are network writes that fail offline. */
  error(message = 'Something went wrong — are you online?'): void {
    this.snack.open(message, 'OK', { duration: 4000 });
  }

  /** A brief neutral confirmation that self-dismisses. */
  notify(message: string): void {
    this.snack.open(message, undefined, { duration: 2500 });
  }

  /** Offer Undo for a just-performed removal. `onUndo` reverses it; `onCommit`
   *  (optional) finalises it when the bar closes without an Undo tap — e.g.
   *  deferring an irreversible cleanup until the undo window has passed. */
  undo(message: string, onUndo: () => void, onCommit?: () => void): void {
    const ref = this.snack.open(message, 'Undo', { duration: 6000 });
    let undone = false;
    ref.onAction().subscribe(() => {
      undone = true;
      onUndo();
    });
    ref.afterDismissed().subscribe(() => {
      if (!undone) onCommit?.();
    });
  }
}
