import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { LifeApi } from '../../life-api';
import { Item } from '../../models';
import { Expiring } from './expiring';

function item(id: number, name: string, expiry: string | null): Item {
  return {
    id,
    product_id: null,
    name,
    brand: null,
    category: 'food',
    quantity: null,
    unit: null,
    expiry,
    location_id: null,
    barcode: null,
    has_image: false,
  };
}

describe('Expiring — use-soon list', () => {
  it('lists only dated items, soonest first, flagged by status', () => {
    const api = {
      items: () => of([item(1, 'No date', null), item(2, 'Later', '2099-01-01'), item(3, 'Past', '2000-01-01')]),
      productImageUrl: (b: string) => `/api/products/${b}/image`,
    };
    TestBed.configureTestingModule({ imports: [Expiring], providers: [{ provide: LifeApi, useValue: api }] });
    const fixture = TestBed.createComponent(Expiring);
    fixture.detectChanges();

    const rows = fixture.componentInstance.rows();
    expect(rows.map((r) => r.item.name)).toEqual(['Past', 'Later']); // undated excluded; soonest first
    expect(rows[0].status).toBe('expired');
    expect(rows[1].status).toBe('later');
  });
});
