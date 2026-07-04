import { test, type Page } from '@playwright/test';
// The fleet-shared harness (code/kubes/ui-harness) — relative import, since
// Playwright transpiles TS outside node_modules but not inside it.
import {
  expectNoTextOverlaps,
  expectNoHorizontalOverflow,
  expectViewportIsPhone,
  expectIconFontLoaded,
} from '../../../ui-harness/src/ui-harness';

/**
 * L2 phone-width layout harness for home — a single-page household-environment
 * dashboard (no router). Render it at a Pixel viewport with the backend mocked
 * and BUSY data, and assert no text collides and nothing overflows the width.
 * The dense, at-risk regions are the metric-grid (4 cards), the room-grid (each
 * card packs name + type + temp + humidity + timestamp + battery), and the
 * Trends range-toggle row beside the section title.
 *
 * No service worker in this app, but block it anyway for parity with the fleet's
 * layout specs — SW-controlled fetches would bypass page.route.
 */
test.use({ serviceWorkers: 'block' });

/** Two air-quality devices; the first drives the hero/AQI badge. A deliberately
 *  long room name stresses the room card's label. */
const DEVICES = [
  {
    ts: '2026-07-01T09:14:00Z', device: '267F', temp_c: 21.4, humidity: 48, co2_ppm: 820,
    pm01: 3, pm25: 7, pm10: 9, aqi_us: 29, voc_ppb: 120, battery: 88, rssi: -58,
    label: { name: 'Living room monitor', room: 'Living room', airQuality: true, order: 0, type: 'airvisual' },
    offset: {},
  },
  {
    ts: '2026-07-01T09:12:00Z', device: 'B7AC', temp_c: 19.8, humidity: 52, co2_ppm: 640,
    pm01: 2, pm25: 5, pm10: 6, aqi_us: 21, voc_ppb: 80, battery: 73, rssi: -71,
    label: { name: 'Bedroom (north-facing, behind the wardrobe)', room: 'Bedroom', airQuality: false, order: 1, type: 'govee' },
    offset: {},
  },
];

/** A short measurement series for the trend charts (any device). */
function series(device: string) {
  const base = Date.UTC(2026, 6, 1, 0, 0, 0);
  return Array.from({ length: 8 }, (_, i) => ({
    ts: new Date(base + i * 3 * 3_600_000).toISOString(),
    device,
    temp_c: 20 + Math.sin(i) * 1.5,
    humidity: 48 + i,
    co2_ppm: 600 + i * 20,
    pm01: 2, pm25: 5 + (i % 3), pm10: 7, aqi_us: 20 + i, voc_ppb: 90, battery: 88, rssi: -60,
  }));
}

/** Mock every backend call. Catch-all FIRST — Playwright runs handlers
 *  last-registered-first, so the specifics below take priority. */
async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/devices', (r) => r.fulfill({ json: DEVICES }));
  await page.route('**/api/measurements*', (r) => {
    const device = new URL(r.request().url()).searchParams.get('device') ?? '267F';
    return r.fulfill({ json: series(device) });
  });
}

// The checker-checker: fail loudly here if the device preset is ever lost and
// the "phone width" suite silently runs at desktop width (defect 2).
test('the suite really runs at phone geometry', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expectViewportIsPhone(page);
});

test('dashboard — hero + metrics + rooms + trends: lays out cleanly @ phone width', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/');
  // Wait for the loaded dashboard (not the "Waiting for the first reading" empty
  // state) — the hero, metric cards, rooms and trends must all have laid out.
  await page.getByText('Indoor air & climate').waitFor();
  await page.getByText('US AQI').waitFor();
  await page.getByText('PM2.5').first().waitFor(); // a metric card ("PM2.5" also titles a chart below)
  await page.getByText('Rooms').waitFor();
  await page.getByText('Trends').waitFor();
  await page.getByText('Bedroom').waitFor(); // a room card rendered (its room label)
  // The toolbar's mat-icons must render as glyphs, not their ligature words.
  await expectIconFontLoaded(page);
  await expectNoTextOverlaps(page, testInfo);
  await expectNoHorizontalOverflow(page, testInfo);
});
