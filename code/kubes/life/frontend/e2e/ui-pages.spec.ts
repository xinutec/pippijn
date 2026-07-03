import { test, type Page } from '@playwright/test';
import { expectNoTextOverlaps } from './ui-overlap';

/**
 * UI-measurement checks (ported from the health-sync frontend): render the
 * main screens at a phone viewport with the backend mocked and busy data,
 * and assert no two pieces of rendered text collide. This is the failure
 * class that reads fine in source and only shows at 390px (the to-do rows'
 * pills crowding the title were exactly this).
 *
 * The service worker is blocked: SW-controlled fetches bypass page.route,
 * and these tests are about layout, not offline (e2e/offline*.spec.ts).
 */
test.use({ serviceWorkers: 'block' });

const iso = (daysFromNow: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ME = { userId: 'test', displayName: 'Test User', avatarUrl: '', nextcloud: 'active' };

/** Busy to-do set: overdue+high (two pills + note), due-soon, ready, waiting. */
const TODOS = [
  { ulid: '01TODOOVERDUE0000000000001', id: 1, title: 'Call the GP about the referral letter',
    type: 'call', status: 'open', priority: 'high', notes: 'ask for the clinic line — they only pick up mornings',
    notBefore: null, due: iso(-3), rev: 1, _deleted: false },
  { ulid: '01TODODUESOON0000000000002', id: 2, title: 'Renew the travel insurance policy',
    type: 'admin', status: 'open', priority: 'medium', notes: null,
    notBefore: null, due: iso(2), rev: 2, _deleted: false },
  { ulid: '01TODOPLAIN000000000000003', id: 3, title: 'Descale the coffee machine',
    type: 'task', status: 'open', priority: null, notes: 'vinegar under the sink',
    notBefore: null, due: null, rev: 3, _deleted: false },
  { ulid: '01TODOWAITING0000000000004', id: 4, title: 'Book the summer service',
    type: 'appointment', status: 'open', priority: 'low', notes: null,
    notBefore: iso(10), due: null, rev: 4, _deleted: false },
];

const SHOPPING = [
  { ulid: '01SHOPA0000000000000000001', id: 1, name: 'Greek yoghurt (the big tubs)',
    quantity: 2, unit: 'tubs', barcode: null, done: false, rev: 1, _deleted: false },
  { ulid: '01SHOPB0000000000000000002', id: 2, name: 'Kidney beans', quantity: 3,
    unit: 'tins', barcode: null, done: true, rev: 2, _deleted: false },
];

const now = new Date();
const at = (daysAgo: number, h: number): string => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, 24, 0, 0);
  return d.toISOString();
};
const WELLBEING = [
  { ulid: '01WELLA0000000000000000001', id: 1, recordedAt: at(0, 9), score: 2,
    note: 'rough morning', rev: 1, _deleted: false },
  { ulid: '01WELLB0000000000000000002', id: 2, recordedAt: at(0, 14), score: 4, note: null, rev: 2, _deleted: false },
  { ulid: '01WELLC0000000000000000003', id: 3, recordedAt: at(1, 20), score: 3, note: null, rev: 3, _deleted: false },
];

const ITEMS = [
  { id: 1, product_id: null, name: 'Milk (semi-skimmed)', brand: null, category: 'food',
    quantity: 1, unit: 'bottle', expiry: iso(-1), location_id: null, barcode: null, has_image: false },
  { id: 2, product_id: null, name: 'Chicken thighs', brand: null, category: 'food',
    quantity: 500, unit: 'g', expiry: iso(1), location_id: null, barcode: null, has_image: false },
];

/** Mock every backend call: pulls return the seed docs, pushes accept all.
 *  Catch-all FIRST — Playwright runs handlers last-registered-first. */
async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/me', (r) => r.fulfill({ json: ME }));
  await page.route('**/api/items*', (r) => r.fulfill({ json: ITEMS }));
  const sync = (docs: unknown[]) => (r: Parameters<Parameters<Page['route']>[1]>[0]) => {
    if (r.request().method() === 'POST') return r.fulfill({ json: [] });
    const since = Number(new URL(r.request().url()).searchParams.get('since') ?? '0');
    // Incremental protocol: only send the seed once, else the pull loops forever.
    const fresh = docs.filter((d) => (d as { rev: number }).rev > since);
    const top = docs.reduce((m, d) => Math.max(m, (d as { rev: number }).rev), since);
    return r.fulfill({ json: { documents: fresh, checkpoint: { rev: top } } });
  };
  await page.route('**/api/sync/todo?*', sync(TODOS));
  await page.route('**/api/sync/todo', sync(TODOS));
  await page.route('**/api/sync/todo_link*', sync([]));
  await page.route('**/api/sync/shopping*', sync(SHOPPING));
  await page.route('**/api/sync/wellbeing*', sync(WELLBEING));
}

test('today — busy composition: no text overlaps @ 390px', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/today');
  await page.getByText('Needs you').waitFor();
  await page.getByText('Call the GP', { exact: false }).waitFor();
  await page.getByText('Expiring soon').waitFor();
  await expectNoTextOverlaps(page, testInfo);
});

test('to-do list — pills in rows: no text overlaps @ 390px', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/todo');
  await page.getByText('Call the GP', { exact: false }).waitFor();
  await page.getByText('overdue', { exact: false }).first().waitFor();
  await expectNoTextOverlaps(page, testInfo);
});

test('wellbeing — chart + timeline: no text overlaps @ 390px', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/wellbeing');
  await page.getByText('How do you feel right now?').waitFor();
  await page.getByText('Last 14 days').waitFor();
  await expectNoTextOverlaps(page, testInfo);
});

test('buy — list + bought bar: no text overlaps @ 390px', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/shopping');
  await page.getByText('Greek yoghurt', { exact: false }).waitFor();
  await page.getByText('add to inventory', { exact: false }).waitFor();
  await expectNoTextOverlaps(page, testInfo);
});

test('settings — about card: no text overlaps @ 390px', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Check for updates' }).waitFor();
  await expectNoTextOverlaps(page, testInfo);
});
