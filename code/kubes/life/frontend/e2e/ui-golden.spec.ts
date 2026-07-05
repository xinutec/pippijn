import { test, expect, type Page } from '@playwright/test';
import { swipeUp } from '@xinutec/ui-harness';

/**
 * Golden-image check — the pixel-diff safety net the layout assertions in
 * ui-pages.spec.ts can't be: it catches things that are laid out fine but
 * *look* wrong (a colour drifting, spacing changing, an icon swapped). One
 * committed baseline lives under e2e/__screenshots__/; regenerate it after an
 * intended visual change with:
 *
 *     npm run ui-golden:update
 *
 * and eyeball the diff in the commit before you keep it.
 *
 * The subject is the to-do edit sheet — what you see when you tap a to-do.
 * Two rules keep the baseline from drifting day to day:
 *   1. we screenshot the SHEET element, not the page — the list behind it has
 *      relative due-dates ("overdue", "in 2 days") that change with today; the
 *      sheet's own content does not, and
 *   2. the seed to-do carries an ABSOLUTE due date and no start-gate, so
 *      nothing in the sheet is computed relative to now.
 *
 * SW blocked (layout, not offline) and fonts awaited (a golden taken mid-FOUT
 * would diff against itself).
 */
test.use({ serviceWorkers: 'block' });

const ME = { userId: 'test', displayName: 'Test User', avatarUrl: '', nextcloud: 'active' };

/** One rich, fully-deterministic to-do: a priority, an absolute due date, a
 *  note — enough that the golden exercises the toggle-groups, the ready banner,
 *  the notes field and a populated date input, none of it relative to today. */
const TODO = {
  ulid: '01GOLDENTODO000000000000001',
  id: 1,
  title: 'Call the GP about the referral letter',
  type: 'call',
  status: 'open',
  priority: 'high',
  notes: 'ask for the clinic line — they only pick up mornings',
  notBefore: null,
  due: '2026-06-30',
  rev: 1,
  _deleted: false,
};

/** Minimal backend: the to-do sync serves the one seed doc; every other sync /
 *  read is empty so the stores settle without error. Incremental protocol, so
 *  the pull terminates instead of re-sending the seed forever. */
async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/**', (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/me', (r) => r.fulfill({ json: ME }));
  const sync = (docs: typeof TODO[]) => (r: Parameters<Parameters<Page['route']>[1]>[0]) => {
    if (r.request().method() === 'POST') return r.fulfill({ json: [] });
    const since = Number(new URL(r.request().url()).searchParams.get('since') ?? '0');
    const fresh = docs.filter((d) => d.rev > since);
    const top = docs.reduce((m, d) => Math.max(m, d.rev), since);
    return r.fulfill({ json: { documents: fresh, checkpoint: { rev: top } } });
  };
  await page.route('**/api/sync/todo?*', sync([TODO]));
  await page.route('**/api/sync/todo', sync([TODO]));
  await page.route('**/api/sync/todo_link*', sync([]));
  await page.route('**/api/sync/shopping*', sync([]));
  await page.route('**/api/sync/wellbeing*', sync([]));
}

test('to-do edit sheet — golden @ phone width', async ({ page }) => {
  await mockApi(page);
  await page.goto('/todo');
  await page.getByText('Call the GP', { exact: false }).click();

  // Wait until the whole form has laid out (its last control is the delete
  // button) and the web fonts + icon font have loaded, so the shot is stable.
  const sheet = page.locator('.mat-bottom-sheet-container');
  await sheet.waitFor();
  await page.getByRole('button', { name: 'Delete to-do' }).waitFor();
  await page.evaluate(() => document.fonts.ready);

  // Capture just the sheet card — the dimmed list behind it (with its relative
  // dates) is excluded, which is what keeps this baseline deterministic.
  await expect(sheet).toHaveScreenshot('todo-edit-sheet.png');
});

/**
 * A real finger swipe up the open sheet. The sheet is capped at 80vh and its
 * form is taller than that, so "Delete to-do" sits below the fold at rest;
 * swiping up should scroll the sheet body and bring it fully into view. We
 * drive genuine touch events through CDP (Input.dispatchTouchEvent) rather
 * than a wheel/scrollTop shortcut, so this also proves touch-scrolling works
 * inside the bottom sheet — the exact gesture a thumb makes on the phone.
 */
test('to-do edit sheet — golden after swiping up @ phone width', async ({ page }) => {
  await mockApi(page);
  await page.goto('/todo');
  await page.getByText('Call the GP', { exact: false }).click();

  const sheet = page.locator('.mat-bottom-sheet-container');
  await sheet.waitFor();
  const deleteBtn = page.getByRole('button', { name: 'Delete to-do' });
  await deleteBtn.waitFor();
  await page.evaluate(() => document.fonts.ready);

  // The sheet slides up on open; measuring or swiping mid-animation reads a
  // half-risen sheet. Wait until it's settled at the viewport bottom.
  await expect
    .poll(() => sheet.evaluate((el) => Math.round(el.getBoundingClientRect().bottom - window.innerHeight)))
    .toBeLessThanOrEqual(1);

  // Precondition: the button we want to reveal really is off-screen at rest —
  // otherwise the swipe would be a no-op and the test would prove nothing.
  expect(await deleteBtn.evaluate((el) => el.getBoundingClientRect().bottom > window.innerHeight)).toBe(
    true,
  );

  // One upward flick through real CDP touch (shared ui-harness swipeUp): a
  // fast, long throw so momentum carries the short scroll all the way to the
  // bottom, where it clamps.
  await swipeUp(page, { from: 780, to: 120 });

  // The one scroller (the sheet container) is at the bottom, clamped, and
  // Delete is now fully on-screen. Poll: momentum settles over a few frames.
  await expect
    .poll(() => sheet.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);
  expect(await deleteBtn.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight)).toBe(
    true,
  );

  await expect(sheet).toHaveScreenshot('todo-edit-sheet-swiped-up.png');
});
