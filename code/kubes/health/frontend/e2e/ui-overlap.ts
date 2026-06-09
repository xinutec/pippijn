import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

/**
 * UI measurement helpers — render a page in a real browser and assert
 * things about the *rendered pixels*, not the source. Born from a string
 * of settings-page bugs (a long `mat-hint` overflowing onto the action
 * buttons; a date `<p>` colliding with the field below it) that all read
 * fine in the code and were only visible at a phone viewport. Reading the
 * source twice certified them "high quality"; the render disagreed.
 *
 * The core signal is text-on-text collision. In a correct layout, no two
 * pieces of text ever share the same pixels. We measure each piece of
 * rendered text at the glyph level — `Range.getClientRects()` returns one
 * box per *visual line*, so wrapping is handled and a paragraph that wraps
 * around an inline `<b>` doesn't produce one giant union box that spuriously
 * overlaps its own child. Two such glyph boxes intersecting is, with very
 * few exceptions, a real bug.
 */

/** A single rendered line of text and where it sits in the viewport. */
export interface TextRect {
	text: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OverlapPair {
	a: TextRect;
	b: TextRect;
	/** Intersection box — how much they actually share. */
	overlap: { w: number; h: number };
}

/**
 * Runs in the browser. Collects every visible text node's per-line glyph
 * rectangles, then returns all pairs that intersect by more than `tol`
 * pixels in BOTH axes (so merely-touching edges and sub-pixel antialiasing
 * seams don't count). Pure DOM — serialised into `page.evaluate`.
 */
export function findTextOverlaps(tol: number): OverlapPair[] {
	const rects: TextRect[] = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = (node.textContent ?? "").trim();
		if (!text) continue;
		const parent = node.parentElement;
		if (!parent) continue;
		const style = getComputedStyle(parent);
		if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
		const range = document.createRange();
		range.selectNodeContents(node);
		for (const r of Array.from(range.getClientRects())) {
			if (r.width < 1 || r.height < 1) continue;
			rects.push({ text, x: r.x, y: r.y, w: r.width, h: r.height });
		}
	}

	const pairs: OverlapPair[] = [];
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) {
			const a = rects[i];
			const b = rects[j];
			const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
			const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
			if (ox > tol && oy > tol) pairs.push({ a, b, overlap: { w: ox, h: oy } });
		}
	}
	return pairs;
}

/**
 * Assert no two pieces of rendered text overlap. On failure, lists the
 * colliding text and by how much, so the report says *what* collided
 * rather than just "pixels differ". Always leaves a full-page screenshot
 * artifact for the eye-check this whole tool exists to make routine.
 */
export async function expectNoTextOverlaps(page: Page, testInfo: TestInfo, tol = 1.5): Promise<void> {
	// Always leave a screenshot at a stable, predictable path (pass OR
	// fail) — eyeballing the render is the habit this tool exists to make
	// cheap. Playwright's own report dir is wiped on a passing test, so we
	// write our own copy under ui-snapshots/ (git-ignored).
	const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
	const path = join(testInfo.project.testDir, "..", "ui-snapshots", `${slug}.png`);
	await mkdir(dirname(path), { recursive: true });
	const shot = await page.screenshot({ fullPage: true, path });
	await testInfo.attach("rendered", { body: shot, contentType: "image/png" });

	const overlaps = await page.evaluate(findTextOverlaps, tol);
	const detail = overlaps
		.map((p) => `  "${p.a.text}" ∩ "${p.b.text}" — ${p.overlap.w.toFixed(1)}×${p.overlap.h.toFixed(1)}px`)
		.join("\n");
	expect(overlaps, `Text overlaps detected:\n${detail}`).toEqual([]);
}
