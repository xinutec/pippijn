import { describe, expect, it } from 'vitest';

import { showThumb } from './product-image';

describe('showThumb', () => {
  it('shows with a barcode + an image (or unknown has_image), no failure', () => {
    expect(showThumb({ barcode: '5036589255550', has_image: true }, false)).toBe(true);
    expect(showThumb({ barcode: '5036589255550' }, false)).toBe(true); // shopping rows: unknown → try
  });

  it('hides without a barcode, when has_image is explicitly false, or after a load failure', () => {
    expect(showThumb({ barcode: null, has_image: true }, false)).toBe(false);
    expect(showThumb({ barcode: '5036589255550', has_image: false }, false)).toBe(false);
    expect(showThumb({ barcode: '5036589255550', has_image: true }, true)).toBe(false);
  });
});
