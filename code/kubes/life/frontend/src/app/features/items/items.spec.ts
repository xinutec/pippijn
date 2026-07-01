import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { LifeApi } from '../../life-api';
import { Item } from '../../models';
import { Items } from './items';

const ITEMS: Item[] = [
  {
    id: 1,
    product_id: 9,
    name: 'Yeo Valley Yoghurt',
    brand: 'Yeo Valley',
    category: 'food',
    quantity: 1,
    unit: 'kg',
    expiry: '2026-07-05',
    location_id: null,
    barcode: '5036589255550',
    has_image: true,
  },
  {
    id: 2,
    product_id: null,
    name: 'Leftover soup',
    brand: null,
    category: 'food',
    quantity: null,
    unit: null,
    expiry: null,
    location_id: null,
    barcode: null,
    has_image: false,
  },
];

describe('Items — complete list', () => {
  it('lists every item, resolved (linked + freeform)', async () => {
    const api = {
      items: () => of(ITEMS),
      locations: () => of([]),
      productImageUrl: (b: string) => `/api/products/${b}/image`,
    };
    TestBed.configureTestingModule({
      imports: [Items],
      providers: [{ provide: LifeApi, useValue: api }],
    });
    const fixture = TestBed.createComponent(Items);
    fixture.autoDetectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.count()).toBe(2);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Yeo Valley Yoghurt'); // catalog-linked
    expect(text).toContain('Leftover soup'); // freeform
  });
});
