import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { Feedback } from './feedback';

/** A controllable MatSnackBar: fire onAction / afterDismissed by hand. */
function setup() {
  const action$ = new Subject<void>();
  const dismissed$ = new Subject<void>();
  const open = vi.fn(() => ({ onAction: () => action$, afterDismissed: () => dismissed$ }));
  TestBed.configureTestingModule({
    providers: [{ provide: MatSnackBar, useValue: { open } }],
  });
  return { feedback: TestBed.inject(Feedback), open, action$, dismissed$ };
}

describe('Feedback', () => {
  it('error() opens a dismissible notice with an OK action', () => {
    const { feedback, open } = setup();
    feedback.error('Boom');
    expect(open).toHaveBeenCalledWith('Boom', 'OK', expect.objectContaining({ duration: 4000 }));
  });

  it('notify() opens a brief self-dismissing message', () => {
    const { feedback, open } = setup();
    feedback.notify('Saved');
    expect(open).toHaveBeenCalledWith('Saved', undefined, expect.objectContaining({ duration: 2500 }));
  });

  it('undo() runs onUndo when the action fires and skips onCommit', () => {
    const { feedback, action$, dismissed$ } = setup();
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    feedback.undo('Deleted', onUndo, onCommit);
    action$.next(); // user tapped Undo
    dismissed$.next(); // bar then closes
    expect(onUndo).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('undo() runs onCommit when the bar dismisses without an Undo tap', () => {
    const { feedback, dismissed$ } = setup();
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    feedback.undo('Deleted', onUndo, onCommit);
    dismissed$.next(); // closed, no undo
    expect(onCommit).toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
  });
});
