import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ImagePickerDirective } from './image-picker';
import { ProductImages } from './product-image';
import { ProductThumb } from './product-thumb';

/** Stub the image service so the component test never touches HttpClient. */
function fakeImages() {
  return {
    url: (barcode: string) => `/api/products/${barcode}/image`,
    replace: vi.fn(() => of(undefined)),
  };
}

async function mount(inputs: { barcode: string | null; hasImage?: boolean }, images = fakeImages()) {
  TestBed.configureTestingModule({
    imports: [ProductThumb],
    providers: [{ provide: ProductImages, useValue: images }],
  });
  const fixture = TestBed.createComponent(ProductThumb);
  fixture.componentRef.setInput('barcode', inputs.barcode);
  fixture.componentRef.setInput('hasImage', inputs.hasImage);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  return fixture;
}

describe('ProductThumb', () => {
  it('renders an inert icon (no picker) when there is no barcode', async () => {
    const fixture = await mount({ barcode: null });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[appImagePicker]')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('label');
  });

  it('shows the cached image and a keyboard-reachable picker for a barcoded item', async () => {
    const fixture = await mount({ barcode: '123', hasImage: true });
    const el = fixture.nativeElement as HTMLElement;
    const img = el.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/products/123/image');
    const picker = el.querySelector('[appImagePicker]');
    expect(picker?.getAttribute('role')).toBe('button');
    expect(picker?.getAttribute('tabindex')).toBe('0');
  });

  it('falls back to the add-a-photo placeholder when the image fails to load', async () => {
    const fixture = await mount({ barcode: '123', hasImage: true });
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('add_a_photo');
  });

  it('offers the picker even with no image yet, and uploads a pick', async () => {
    const images = fakeImages();
    const fixture = await mount({ barcode: '123', hasImage: false }, images);
    const el = fixture.nativeElement as HTMLElement;
    // No image, but the placeholder is still the tappable picker.
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[appImagePicker]')).not.toBeNull();

    // Emit through the real picker directive — exercises the wiring too.
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const picker = fixture.debugElement
      .query(By.directive(ImagePickerDirective))
      .injector.get(ImagePickerDirective);
    picker.imagePicked.emit(blob);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(images.replace).toHaveBeenCalledWith('123', blob);
    // After a successful upload the image shows even though hasImage was false.
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/api/products/123/image');
  });
});
