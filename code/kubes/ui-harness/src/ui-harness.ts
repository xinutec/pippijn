import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

/**
 * ui-harness — the fleet's shared phone-width layout checks (L2 of
 * dev-lint/docs/layout-quality-architecture.md). Render a page in a real
 * browser at true device geometry and assert about the *painted pixels*,
 * not the source. Born in the life app from a string of bugs that all read
 * fine in code and were only visible on the phone: a 497px toggle row in a
 * 380px sheet, nested scrollers that broke swipe, text colliding at 412px.
 *
 * Consumed by RELATIVE import from each app's e2e/ (Playwright transpiles
 * TS outside node_modules; a file: dep symlink would not be transpiled).
 * Change here → run this package's own fixture specs (npm test) — five
 * apps ride on these functions.
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
	/** Which text node this came from — same-node rects never "collide". */
	node?: number;
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
export function findTextOverlaps(args: [string | null, number]): OverlapPair[] {
	const [rootSel, tol] = args;
	// Scope to a container when given — measuring a modal (a bottom sheet)
	// means measuring only ITS text. An open sheet is opaque and covers the
	// list behind it, but getClientRects can't see occlusion, so a whole-body
	// scan would count the covered list text as colliding with the sheet text
	// drawn on top. That's a false positive; the container scope removes it.
	const root = rootSel ? document.querySelector(rootSel) : document.body;
	if (!root) return [];
	const rects: TextRect[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let nodeIdx = 0;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = (node.textContent ?? "").trim();
		if (!text) continue;
		const parent = node.parentElement;
		if (!parent) continue;
		const style = getComputedStyle(parent);
		if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
		nodeIdx++;
		const range = document.createRange();
		range.selectNodeContents(node);
		for (const r of Array.from(range.getClientRects())) {
			// Clip the glyph box to every overflow-clipping ancestor: an
			// ellipsized nowrap line reports its FULL laid-out width here, but
			// everything past the ancestor's `overflow: hidden` edge is never
			// painted, so it can't visually collide with anything. Without this,
			// every ellipsized list title "overlaps" the pill sitting after it.
			let x1 = r.x;
			let y1 = r.y;
			let x2 = r.right;
			let y2 = r.bottom;
			for (let p: Element | null = parent; p; p = p.parentElement) {
				const ps = getComputedStyle(p);
				if (ps.overflowX !== "visible" || ps.overflowY !== "visible") {
					const pb = p.getBoundingClientRect();
					x1 = Math.max(x1, pb.x);
					y1 = Math.max(y1, pb.y);
					x2 = Math.min(x2, pb.right);
					y2 = Math.min(y2, pb.bottom);
				}
			}
			if (x2 - x1 < 1 || y2 - y1 < 1) continue;
			rects.push({ text, x: x1, y: y1, w: x2 - x1, h: y2 - y1, node: nodeIdx });
		}
	}

	const pairs: OverlapPair[] = [];
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) {
			const a = rects[i];
			const b = rects[j];
			// One text node can't collide with itself — Chrome reports an extra
			// same-position fragment rect for ellipsized text.
			if (a.node === b.node) continue;
			const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
			const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
			if (ox > tol && oy > tol) pairs.push({ a, b, overlap: { w: ox, h: oy } });
		}
	}
	return pairs;
}

/**
 * Write a full-page screenshot to a stable, predictable path (pass OR fail) —
 * eyeballing the render is the habit this whole tool exists to make cheap.
 * Playwright's own report dir is wiped on a passing test, so we keep our own
 * copy under ui-snapshots/ (git-ignored). Returns nothing; also attaches it to
 * the test report.
 */
async function leaveSnapshot(page: Page, testInfo: TestInfo): Promise<void> {
	const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
	const path = join(testInfo.project.testDir, "..", "ui-snapshots", `${slug}.png`);
	await mkdir(dirname(path), { recursive: true });
	const shot = await page.screenshot({ fullPage: true, path });
	await testInfo.attach("rendered", { body: shot, contentType: "image/png" });
}

/**
 * Assert no two pieces of rendered text overlap. On failure, lists the
 * colliding text and by how much, so the report says *what* collided
 * rather than just "pixels differ". Always leaves a full-page screenshot
 * artifact for the eye-check this whole tool exists to make routine.
 */
export async function expectNoTextOverlaps(
	page: Page,
	testInfo: TestInfo,
	rootSel: string | null = null,
	tol = 1.5,
): Promise<void> {
	await leaveSnapshot(page, testInfo);

	const overlaps = await page.evaluate(findTextOverlaps, [rootSel, tol] as [string | null, number]);
	const detail = overlaps
		.map((p) => `  "${p.a.text}" ∩ "${p.b.text}" — ${p.overlap.w.toFixed(1)}×${p.overlap.h.toFixed(1)}px`)
		.join("\n");
	expect(overlaps, `Text overlaps detected:\n${detail}`).toEqual([]);
}

/** An element whose right edge spills past the viewport (or the given root). */
export interface Overflower {
	sel: string;
	text: string;
	/** How far past the right edge it reaches, in px. */
	spill: number;
}

/**
 * Runs in the browser. The other layout failure class at a phone width: content
 * wider than the screen. A too-wide element either forces a horizontal page
 * scroll (nothing on a phone should scroll sideways) or spills out of a fixed
 * container like a bottom sheet. The mat-button-toggle-group is the classic
 * culprit — it lays its options in one non-wrapping row, so five typed options
 * with icons happily exceed 412px.
 *
 * We flag every visible element whose right edge sits more than `tol` past
 * `root`'s right edge — EXCEPT ones inside a container named in `allow`, an
 * explicit list of selectors for the few places that scroll horizontally on
 * purpose. Explicit, because the "obvious" computed-style test (overflow-x:
 * auto/scroll) is a trap: per CSS, `overflow-y: auto` forces overflow-x to
 * compute to auto as well, so every merely-vertically-scrollable container
 * (a bottom sheet's body, say) silently exempted everything inside it — which
 * is exactly how a 497px toggle row hid inside a 380px sheet.
 * `args` is [rootSel|null, tol, allow]; a null root means the viewport.
 */
export function findHorizontalOverflow(args: [string | null, number, string[]]): {
	rootWidth: number;
	scrollOverflow: number;
	offenders: Overflower[];
} {
	const [rootSel, tol, allow] = args;
	const root = rootSel ? document.querySelector(rootSel) : document.documentElement;
	if (!root) return { rootWidth: 0, scrollOverflow: 0, offenders: [] };
	const rootRect = root.getBoundingClientRect();
	// documentElement.clientWidth, NOT window.innerWidth: under mobile
	// emulation an overflowing page EXPANDS innerWidth to the layout width
	// (700px div → innerWidth 700), so an innerWidth-keyed check goes blind
	// exactly when there's something to catch. clientWidth stays the true
	// viewport. (Found by this package's own fixture specs.)
	const rightEdge = rootSel ? rootRect.right : document.documentElement.clientWidth;

	const inAllowedScroller = (el: Element): boolean =>
		allow.some((sel) => el.closest(sel) !== null);
	const describe = (el: Element): string => {
		const cls = typeof el.className === "string" && el.className.trim()
			? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
			: "";
		return el.tagName.toLowerCase() + cls;
	};

	const seen = new Set<string>();
	const offenders: Overflower[] = [];
	for (const el of Array.from(root.querySelectorAll("*"))) {
		const style = getComputedStyle(el);
		if (style.visibility === "hidden" || style.display === "none") continue;
		if (inAllowedScroller(el)) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) continue;
		const spill = r.right - rightEdge;
		if (spill <= tol) continue;
		const sel = describe(el);
		// One row per (selector, rounded-spill) so a stack of nested offenders
		// that all spill by the same amount collapses to its outermost note.
		const key = `${sel}@${Math.round(spill)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		offenders.push({ sel, text: (el.textContent ?? "").trim().slice(0, 40), spill });
	}
	offenders.sort((a, b) => b.spill - a.spill);

	// scrollWidth vs clientWidth on the root is the single scalar "does it spill"
	// signal, independent of the per-element attribution above.
	const scrollOverflow = rootSel
		? (root as HTMLElement).scrollWidth - (root as HTMLElement).clientWidth
		: document.documentElement.scrollWidth - document.documentElement.clientWidth;
	return { rootWidth: rightEdge - rootRect.left, scrollOverflow, offenders };
}

/**
 * Assert nothing spills past the right edge at a phone width. `rootSel` scopes
 * the check to a container (e.g. an open bottom sheet); omit it to check the
 * whole viewport. `allow` names containers that scroll horizontally on purpose
 * (see findHorizontalOverflow for why this is an explicit list). Leaves the
 * same screenshot artifact as the overlap check.
 */
export async function expectNoHorizontalOverflow(
	page: Page,
	testInfo: TestInfo,
	rootSel: string | null = null,
	allow: string[] = [],
	tol = 1,
): Promise<void> {
	await leaveSnapshot(page, testInfo);

	const { offenders } = await page.evaluate(findHorizontalOverflow, [rootSel, tol, allow] as [
		string | null,
		number,
		string[],
	]);
	const detail = offenders
		.map((o) => `  ${o.sel} — spills ${o.spill.toFixed(1)}px${o.text ? ` — "${o.text}"` : ""}`)
		.join("\n");
	expect(offenders, `Horizontal overflow at phone width:\n${detail}`).toEqual([]);
}

/**
 * The checker-checker. Life's "phone width" suite silently ran at 1280×720
 * for months because a device spread in the PROJECT `use` overrode the
 * global viewport — every assertion measured a desktop render while the
 * test titles said 390px. One spec per app calls this; if emulation ever
 * silently drops again, the whole suite fails loudly instead of lying.
 */
export async function expectViewportIsPhone(page: Page, width = 412): Promise<void> {
	const geo = await page.evaluate(() => ({
		// clientWidth, not innerWidth — innerWidth expands with overflowing
		// content under mobile emulation, and an app bug shouldn't read as a
		// broken test config.
		w: document.documentElement.clientWidth,
		touch: navigator.maxTouchPoints > 0,
	}));
	expect(geo.w, `viewport width is ${geo.w}, expected the phone's ${width} CSS px`).toBe(width);
	expect(geo.touch, "touch emulation is off — the device preset was lost").toBe(true);
}

/**
 * A real finger flick up the screen via CDP touch events (touchStart → N
 * touchMoves → touchEnd), NOT a scrollTop/wheel shortcut — it proves the
 * gesture itself works. That distinction found a real bug: nested scrollers
 * in a bottom sheet each ate part of the swipe and the bottom was
 * unreachable, while element.scrollTop happily reached it.
 */
export async function swipeUp(
	page: Page,
	opts: { x?: number; from?: number; to?: number; steps?: number } = {},
): Promise<void> {
	const vp = page.viewportSize();
	const x = opts.x ?? Math.round((vp?.width ?? 412) / 2);
	const from = opts.from ?? Math.round((vp?.height ?? 915) * 0.85);
	const to = opts.to ?? Math.round((vp?.height ?? 915) * 0.15);
	const steps = opts.steps ?? 12;
	const touch = await page.context().newCDPSession(page);
	await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
	for (let i = 1; i <= steps; i++) {
		const y = from + ((to - from) * i) / steps;
		await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
	}
	await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await touch.detach();
}

/**
 * Assert `target` can actually be reached by swiping: flick up (repeatedly,
 * bounded) until its bottom edge is inside the viewport, then require the
 * scroller (`scrollerSel`) to be clamped at or before its scroll end. Fails
 * when nested scrollers fight over the gesture or the target simply can't
 * come on-screen.
 */
export async function expectReachableByScroll(
	page: Page,
	target: Locator,
	scrollerSel: string,
	maxSwipes = 6,
): Promise<void> {
	for (let i = 0; i < maxSwipes; i++) {
		const visible = await target.evaluate(
			(el) => el.getBoundingClientRect().bottom <= window.innerHeight,
		);
		if (visible) break;
		await swipeUp(page);
		// Let scroll momentum settle before re-measuring.
		await page
			.locator(scrollerSel)
			.evaluate(
				(el) =>
					new Promise<void>((done) => {
						let last = el.scrollTop;
						const tick = () => {
							if (el.scrollTop === last) return done();
							last = el.scrollTop;
							requestAnimationFrame(tick);
						};
						requestAnimationFrame(tick);
					}),
			);
	}
	expect(
		await target.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight),
		`target still below the fold after ${maxSwipes} swipes — is a nested scroller eating the gesture?`,
	).toBe(true);
}
