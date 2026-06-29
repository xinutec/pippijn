import { expect, type Page } from "@playwright/test";

/**
 * UI measurement helpers — render in a real browser and assert facts about the
 * *rendered pixels*, not the source. Ported from the health app, where a run of
 * layout bugs read fine in code and were only visible at a phone viewport.
 *
 * The core signal is text-on-text collision: in a correct layout no two pieces
 * of text share pixels. This also catches an icon font silently falling back to
 * its ligature word — e.g. a `mat-icon` rendering the literal text "search"
 * (because the icon font isn't loaded) overlaps the field's placeholder.
 */

interface TextRect {
  text: string;
  node: number; // index of the source text node, so a node can't collide with itself
  sticky: boolean; // under a position:sticky ancestor (intentional floating overlay)
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OverlapPair {
  a: TextRect;
  b: TextRect;
  overlap: { w: number; h: number };
}

/** Runs in the browser: every visible text node's per-line glyph rects (each
 *  CLAMPED to its clipping ancestors, so legitimately ellipsis-/overflow-clipped
 *  text isn't measured beyond what's actually visible), then all pairs from
 *  DIFFERENT nodes intersecting by more than `tol` px in BOTH axes. */
function findTextOverlaps(tol: number): OverlapPair[] {
  // Visible clip box for an element = viewport ∩ every overflow!=visible ancestor.
  function clipBox(el: Element) {
    let left = 0;
    let top = 0;
    let right = window.innerWidth;
    let bottom = window.innerHeight;
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        const c = n.getBoundingClientRect();
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
    }
    return { left, top, right, bottom };
  }

  const rects: TextRect[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let nodeId = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    const parent = node.parentElement;
    if (!text || !parent) {
      nodeId++;
      continue;
    }
    const style = getComputedStyle(parent);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      nodeId++;
      continue;
    }
    let sticky = false;
    for (let n: Element | null = parent; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).position === "sticky") {
        sticky = true;
        break;
      }
    }
    const clip = clipBox(parent);
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) {
      const x = Math.max(r.left, clip.left);
      const y = Math.max(r.top, clip.top);
      const w = Math.min(r.right, clip.right) - x;
      const h = Math.min(r.bottom, clip.bottom) - y;
      if (w < 1 || h < 1) continue; // clipped away / off-screen
      rects.push({ text, node: nodeId, sticky, x, y, w, h });
    }
    nodeId++;
  }

  const pairs: OverlapPair[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.node === b.node) continue; // a node can't meaningfully overlap itself
      // A sticky element floating over normal content is intentional (e.g. the
      // pinned date pill over messages). Two stickies overlapping IS a bug
      // (stacked headers); two normals overlapping is a layout bug.
      if (a.sticky !== b.sticky) continue;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > tol && oy > tol) pairs.push({ a, b, overlap: { w: ox, h: oy } });
    }
  }
  return pairs;
}

/** Assert no two pieces of rendered text overlap. */
export async function expectNoTextOverlaps(page: Page, tol = 1.5): Promise<void> {
  const overlaps = await page.evaluate(findTextOverlaps, tol);
  const detail = overlaps
    .map((p) => `  "${p.a.text}" ∩ "${p.b.text}" — ${p.overlap.w.toFixed(1)}×${p.overlap.h.toFixed(1)}px`)
    .join("\n");
  expect(overlaps, `Text overlaps detected:\n${detail}`).toEqual([]);
}

/** Assert the Material Icons font face is actually present AND loaded, so
 *  `mat-icon` ligatures render as glyphs rather than their fallback word — the
 *  exact failure that shipped once (the wrong font family was linked).
 *
 *  NB `document.fonts.check('24px "Material Icons"')` is NOT usable here: it
 *  returns `true` even when the family doesn't exist (nothing to load). We must
 *  confirm a FontFace with that family is in the set and `status === "loaded"`.
 *  Fonts load lazily once a glyph uses them, so poll until it settles; a missing
 *  family never settles → fails. */
export async function expectIconFontLoaded(page: Page): Promise<void> {
  const loaded = await page
    .waitForFunction(
      () =>
        Array.from(document.fonts).some(
          (f) => f.family.replace(/['"]/g, "") === "Material Icons" && f.status === "loaded",
        ),
      null,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  expect(loaded, 'the "Material Icons" font face never loaded — mat-icon will show ligature text').toBe(true);
}
