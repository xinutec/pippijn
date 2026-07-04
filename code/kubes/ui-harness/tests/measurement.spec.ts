import { test, expect } from '@playwright/test';
import {
  findTextOverlaps,
  findHorizontalOverflow,
  findOccludedControls,
  expectViewportIsPhone,
  swipeUp,
} from '../src/ui-harness';


/** setContent replaces the whole document — without a viewport meta, mobile
 *  emulation falls back to the 980px legacy layout width and nothing measures
 *  at phone geometry (the viewport-guard fixture below proved this the hard
 *  way on its first run). Wrap every fixture with the meta a real app has. */
const phonePage = (body: string): string =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">${body}</body></html>`;

/**
 * Fixture specs for the measurement functions — every case here is a
 * false-positive or false-negative class found LIVE while the harness ran
 * against the life app. Five apps consume these functions; a change that
 * breaks a case below will misreport layout across the fleet.
 */

test('detects a real text-on-text collision', async ({ page }) => {
  await page.setContent(phonePage(`
    <div style="position: relative; font: 16px sans-serif;">
      <span style="position: absolute; left: 10px; top: 10px;">first piece</span>
      <span style="position: absolute; left: 30px; top: 14px;">second piece</span>
    </div>`));
  const pairs = await page.evaluate(findTextOverlaps, [null, 1.5] as [string | null, number]);
  expect(pairs.length).toBe(1);
});

test('ellipsized nowrap text does NOT collide with the element after it', async ({ page }) => {
  // The phantom-rect case: Chrome reports the FULL laid-out width of an
  // ellipsized text node plus a fragment rect at the same origin. Unclipped,
  // the full rect "overlaps" the pill next to it and the fragment "overlaps"
  // its own node. Both must stay silent.
  await page.setContent(phonePage(`
    <div style="display: flex; width: 300px; font: 16px sans-serif;">
      <div style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        a very long title that cannot possibly fit inside three hundred pixels of flexbox
      </div>
      <span style="flex: none;">pill</span>
    </div>`));
  const pairs = await page.evaluate(findTextOverlaps, [null, 1.5] as [string | null, number]);
  expect(pairs).toEqual([]);
});

test('paint-clipped text does not collide through an overflow:hidden edge', async ({ page }) => {
  // Text overflowing a clipped box is not painted beyond the edge — glyphs
  // that are never drawn cannot collide with what sits beyond them.
  await page.setContent(phonePage(`
    <div style="font: 16px sans-serif;">
      <div style="width: 120px; overflow: hidden; white-space: nowrap; float: left;">
        overflowing content here
      </div>
      <span style="float: left;">neighbour</span>
    </div>`));
  const pairs = await page.evaluate(findTextOverlaps, [null, 1.5] as [string | null, number]);
  expect(pairs).toEqual([]);
});

test('a badge sitting on an icon glyph is NOT a collision', async ({ page }) => {
  // matBadge over a mat-icon: the icon's ligature word ("warning") is a glyph,
  // not text, and a badge on its corner is intended. Must stay silent.
  await page.setContent(phonePage(`
    <div style="position: relative; display: inline-flex; font: 16px sans-serif;">
      <mat-icon class="material-icons" style="font-family: sans-serif;">warning</mat-icon>
      <span style="position: absolute; top: 0; right: 0;">3</span>
    </div>`));
  const pairs = await page.evaluate(findTextOverlaps, [null, 1.5] as [string | null, number]);
  expect(pairs).toEqual([]);
});

test('detects an element spilling past the viewport', async ({ page }) => {
  await page.setContent(phonePage(`
    <div style="width: 700px; height: 40px; background: tomato;">too wide for a 412px phone</div>`));
  const res = await page.evaluate(findHorizontalOverflow, [null, 1, []] as [
    string | null,
    number,
    string[],
  ]);
  expect(res.offenders.length).toBeGreaterThan(0);
});

test('a vertical scroller does NOT exempt its overflowing children', async ({ page }) => {
  // The computed-style trap: overflow-y:auto forces overflow-x to compute
  // auto, which used to exempt the whole subtree. The 700px child inside a
  // merely-vertically-scrollable box must still be flagged.
  await page.setContent(phonePage(`
    <div style="max-height: 200px; overflow-y: auto;">
      <div style="width: 700px; height: 40px;">hiding inside a vertical scroller</div>
    </div>`));
  const res = await page.evaluate(findHorizontalOverflow, [null, 1, []] as [
    string | null,
    number,
    string[],
  ]);
  expect(res.offenders.length).toBeGreaterThan(0);
});

test('the explicit allow-list exempts an intended horizontal scroller', async ({ page }) => {
  await page.setContent(phonePage(`
    <div class="carousel" style="overflow-x: auto;">
      <div style="width: 700px; height: 40px;">deliberately wide, scrollable by design</div>
    </div>`));
  const flagged = await page.evaluate(findHorizontalOverflow, [null, 1, []] as [
    string | null,
    number,
    string[],
  ]);
  expect(flagged.offenders.length).toBeGreaterThan(0); // without the allow-list: flagged
  const allowed = await page.evaluate(findHorizontalOverflow, [null, 1, ['.carousel']] as [
    string | null,
    number,
    string[],
  ]);
  expect(allowed.offenders).toEqual([]); // with it: exempt
});

test('a position:fixed bar and its children are not flagged for overflow', async ({ page }) => {
  // Fixed/sticky elements are out of flow — they never cause horizontal PAGE
  // scroll, and a viewport-wide fixed bar (plus everything laid out inside it, like
  // a nav's tab links) spuriously "spills" by the scrollbar width on a scrolling
  // page. Both the fixed bar AND its wide child must stay silent — a flow div of
  // the same width (above) IS flagged, so this proves the fixed-skip, not a width
  // bug.
  await page.setContent(phonePage(`
    <div style="position: fixed; top: 0; left: 0; height: 40px;">
      <span style="display: inline-block; width: 700px;">wide child of a fixed bar</span>
    </div>`));
  const res = await page.evaluate(findHorizontalOverflow, [null, 1, []] as [
    string | null,
    number,
    string[],
  ]);
  expect(res.offenders).toEqual([]);
});

test('viewport guard passes under the Pixel preset and reports geometry', async ({ page }) => {
  await page.setContent(phonePage('<p>hi</p>'));
  await expectViewportIsPhone(page);
});

test('swipeUp really scrolls a page taller than the viewport', async ({ page }) => {
  await page.setContent(phonePage(`
    <div style="height: 3000px;">
      <div id="top">top</div>
    </div>`));
  const before = await page.evaluate(() => window.scrollY);
  await swipeUp(page);
  // Momentum needs a beat; poll until movement (or fail on timeout).
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
});

// coach's real bug, reduced: a FAB in a bottom-anchored bar whose nav-clearance
// was dropped, so it sits UNDER a fixed nav painted on top (higher z-index).
const fabOverNav = (fabBottomPad: string): string => `
  <div style="position: fixed; inset: auto 0 0 0; display: flex; justify-content: flex-end;
              padding: 0 1rem ${fabBottomPad}; z-index: 5; pointer-events: none;">
    <button class="add-fab" style="width: 56px; height: 56px; pointer-events: auto;">+</button>
  </div>
  <nav style="position: fixed; inset: auto 0 0 0; height: 60px; z-index: 10; background: #333;">nav</nav>`;

test('detects a FAB occluded by a fixed bottom nav', async ({ page }) => {
  // 8px bottom padding: the FAB overlaps the 60px nav painted on top of it.
  await page.setContent(phonePage(fabOverNav('8px')));
  const occ = await page.evaluate(findOccludedControls, ['button', []] as [string, string[]]);
  expect(occ.map((o) => o.sel)).toEqual(['button.add-fab']);
});

test('a FAB with nav-clearance is NOT occluded', async ({ page }) => {
  // 68px bottom padding (60px nav + 8px): the FAB clears the nav — reachable.
  await page.setContent(phonePage(fabOverNav('68px')));
  const occ = await page.evaluate(findOccludedControls, ['button', []] as [string, string[]]);
  expect(occ).toEqual([]);
});

test('a pointer-events:none overlay does not count as occluding', async ({ page }) => {
  // A full-screen scrim with pointer-events:none must not read as covering the
  // button beneath it — elementFromPoint sees through it.
  await page.setContent(phonePage(`
    <button style="position: fixed; top: 40px; left: 40px; width: 56px; height: 56px;">ok</button>
    <div style="position: fixed; inset: 0; z-index: 99; pointer-events: none;"></div>`));
  const occ = await page.evaluate(findOccludedControls, ['button', []] as [string, string[]]);
  expect(occ).toEqual([]);
});
