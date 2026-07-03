import { test, expect } from '@playwright/test';
import {
  findTextOverlaps,
  findHorizontalOverflow,
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
