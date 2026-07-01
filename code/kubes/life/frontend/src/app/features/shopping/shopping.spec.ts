import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatDialog } from '@angular/material/dialog';

import { LifeApi } from '../../life-api';
import { ShoppingStore } from '../../sync/shopping-store';
import { Shopping } from './shopping';

/**
 * Regression test for the zoneless scan-prefill bug: a barcode scan sets the
 * form fields inside an async (dialog-close → HTTP) callback. With plain fields
 * that doesn't trigger change detection in a zoneless app, so the inputs stayed
 * empty even though the lookup ran. The fields are signals now; this guards it
 * by asserting the *rendered* input value — not just component state — after a
 * scan, with auto change detection (no manual detectChanges that would mask it).
 */
describe('Shopping — barcode scan', () => {
  function setup(scanned: string | null) {
    const dialog = { open: vi.fn(() => ({ afterClosed: () => of(scanned) })) };
    const api = {
      lookupProduct: vi.fn(() =>
        of({ barcode: scanned, name: 'Nomadic', brand: 'Lassi', quantity_label: null, has_image: false }),
      ),
      productImageUrl: (b: string) => `/api/products/${b}/image`,
    };
    const store = {
      items$: of([]),
      syncError: signal<string | null>(null),
      add: vi.fn(),
      setDone: vi.fn(),
      remove: vi.fn(),
      clearDone: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [Shopping],
      providers: [
        { provide: LifeApi, useValue: api },
        { provide: ShoppingStore, useValue: store },
      ],
    });
    // Shopping imports MatDialogModule, which re-provides the real MatDialog at
    // the component injector — overrideProvider forces our stub at every level.
    TestBed.overrideProvider(MatDialog, { useValue: dialog });
    return TestBed.createComponent(Shopping);
  }

  it('fills the barcode field and prefills the name from the scanned product', async () => {
    const fixture = setup('5029617001045');
    fixture.autoDetectChanges();
    fixture.componentInstance.scan();
    await fixture.whenStable();

    // Component state: the scan wired through dialog → lookup → signals.
    expect(fixture.componentInstance.barcode()).toBe('5029617001045');
    expect(fixture.componentInstance.name()).toBe('Nomadic');

    // Rendered view reflects it (this is what the zoneless bug broke).
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    expect(input.value).toBe('5029617001045');
  });

  it('leaves the form untouched when the scan is cancelled', async () => {
    const fixture = setup(null);
    fixture.autoDetectChanges();
    fixture.componentInstance.scan();
    await fixture.whenStable();
    expect(fixture.componentInstance.barcode()).toBe('');
    expect(fixture.componentInstance.name()).toBe('');
  });
});
