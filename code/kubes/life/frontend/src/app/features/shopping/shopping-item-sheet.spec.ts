import { TestBed } from '@angular/core/testing';
import {
  MAT_BOTTOM_SHEET_DATA,
  MatBottomSheetRef,
} from '@angular/material/bottom-sheet';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { Feedback } from '../../shared/feedback';
import { LifeApi } from '../../life-api';
import { ShoppingDoc, ShoppingStore } from '../../sync/shopping-store';
import { ShoppingItemSheet } from './shopping-item-sheet';

const doc = (over: Partial<ShoppingDoc>): ShoppingDoc => ({
  ulid: 'u1',
  id: 1,
  name: 'Yoghurt',
  quantity: 2,
  unit: 'pots',
  barcode: null,
  done: false,
  rev: 1,
  ...over,
});

/**
 * Carries the zoneless scan-prefill regression coverage (a scan sets form
 * fields inside an async dialog-close → HTTP callback; signals are what make
 * the zoneless view update) — now living in the bottom sheet.
 */
describe('ShoppingItemSheet', () => {
  function setup(opts: { scanned?: string | null; data?: { ulid: string } | null; items?: ShoppingDoc[] } = {}) {
    const dialog = { open: vi.fn(() => ({ afterClosed: () => of(opts.scanned ?? null) })) };
    const api = {
      lookupProduct: vi.fn(() =>
        of({ barcode: opts.scanned, name: 'Nomadic', brand: 'Lassi', quantity_label: null, has_image: false }),
      ),
      productImageUrl: (b: string) => `/api/products/${b}/image`,
    };
    const store = {
      items$: of(opts.items ?? []),
      add: vi.fn().mockResolvedValue('new-ulid'),
      patch: vi.fn().mockResolvedValue(undefined),
    };
    const ref = { dismiss: vi.fn() };
    TestBed.configureTestingModule({
      imports: [ShoppingItemSheet],
      providers: [
        { provide: LifeApi, useValue: api },
        { provide: ShoppingStore, useValue: store },
        { provide: MatBottomSheetRef, useValue: ref },
        { provide: MAT_BOTTOM_SHEET_DATA, useValue: opts.data ?? null },
        { provide: Feedback, useValue: { notify: vi.fn(), error: vi.fn() } },
      ],
    });
    // The sheet imports MatDialogModule, which re-provides the real MatDialog at
    // the component injector — overrideProvider forces our stub at every level.
    TestBed.overrideProvider(MatDialog, { useValue: dialog });
    return { fixture: TestBed.createComponent(ShoppingItemSheet), store, ref };
  }

  it('fills the barcode field and prefills the name from the scanned product', async () => {
    const { fixture } = setup({ scanned: '5029617001045' });
    fixture.autoDetectChanges();
    fixture.componentInstance.scan();
    await fixture.whenStable();

    expect(fixture.componentInstance.barcode()).toBe('5029617001045');
    expect(fixture.componentInstance.name()).toBe('Nomadic');

    // Rendered view reflects it (this is what the zoneless bug broke).
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input[inputmode="numeric"]',
    )!;
    expect(input.value).toBe('5029617001045');
  });

  it('leaves the form untouched when the scan is cancelled', async () => {
    const { fixture } = setup({ scanned: null });
    fixture.autoDetectChanges();
    fixture.componentInstance.scan();
    await fixture.whenStable();
    expect(fixture.componentInstance.barcode()).toBe('');
    expect(fixture.componentInstance.name()).toBe('');
  });

  it('add mode: saves and stays open with cleared fields', () => {
    const { fixture, store, ref } = setup();
    const c = fixture.componentInstance;
    c.name.set(' Milk ');
    c.quantity.set(1);
    c.save();
    expect(store.add).toHaveBeenCalledWith({ name: 'Milk', quantity: 1, unit: null, barcode: null });
    expect(ref.dismiss).not.toHaveBeenCalled();
    expect(c.name()).toBe('');
    expect(c.quantity()).toBeNull();
  });

  it('add mode: ignores an empty name', () => {
    const { fixture, store } = setup();
    fixture.componentInstance.save();
    expect(store.add).not.toHaveBeenCalled();
  });

  it('edit mode: pre-fills from the doc and Save patches + closes', () => {
    const item = doc({ ulid: 'u7', name: 'Beans', quantity: 3, unit: 'tins' });
    const { fixture, store, ref } = setup({ data: { ulid: 'u7' }, items: [item] });
    const c = fixture.componentInstance;
    expect(c.editing).toBe(true);
    expect(c.name()).toBe('Beans');
    c.quantity.set(4);
    c.save();
    expect(store.patch).toHaveBeenCalledWith('u7', {
      name: 'Beans',
      quantity: 4,
      unit: 'tins',
      barcode: null,
    });
    expect(ref.dismiss).toHaveBeenCalled();
  });
});
