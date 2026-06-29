import { expect, test, type Page } from "@playwright/test";
import { expectIconFontLoaded, expectNoTextOverlaps } from "./ui-overlap";

/**
 * Render the authenticated app shell at a phone viewport with the backend
 * mocked, and assert the render is sound: the Material Icons font loaded (so the
 * search/back/attachment glyphs aren't their ligature words) and no text
 * collides. This is the check that would have caught the icon-font regression —
 * unit tests (jsdom) can't see fonts or layout.
 */

const ME = { user_id: "pippijn", display_name: "Pippijn van Steenhoven" };

const CONVERSATIONS = [
  { origin: "signal", id: "dm:a", name: "Alice", kind: "dm", message_count: 5, last_ts: 1_717_000_000_000 },
  { origin: "gchat", id: "gc1", name: "Bob", kind: "dm", message_count: 3, last_ts: 1_717_100_000_000 },
];

/** Mock every backend call the shell makes so it renders with no server/auth.
 *  Catch-all registered FIRST: Playwright runs handlers last-registered-first. */
async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("**/api/me", (r) => r.fulfill({ json: ME }));
  await page.route("**/api/conversations", (r) => r.fulfill({ json: CONVERSATIONS }));
}

test("authenticated shell renders: icon font loaded, no text overlaps @ 390px", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  // The search field (with its prefix icon) is the spot the bug showed up.
  await page.getByPlaceholder("Search messages").waitFor();
  await page.getByText("Alice").waitFor();
  await expectIconFontLoaded(page);
  await expectNoTextOverlaps(page);
});

// Two days, each tall enough (25 messages) to exceed the viewport so a day's
// sticky header actually pins while scrolling within it.
function multiDayThread() {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0); // Jan 1 (Thu), Jan 2 (Fri)
  const out = [];
  for (let d = 0; d < 2; d++) {
    for (let k = 0; k < 25; k++) {
      const ts = base + d * 86_400_000 + k * 60_000;
      out.push({ id: `${d}-${k}`, ts, sender: "Alice", is_outgoing: false, body: `msg ${d}-${k}`, deleted: false, edited: false, reactions: [], attachments: [] });
    }
  }
  return out;
}

test("a scrolled multi-day thread does not stack date separators", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/conversations/**/messages**", (r) =>
    r.fulfill({ json: { messages: multiDayThread(), has_more: false, next_before: null } }),
  );
  await page.goto("/?chat=signal:dm:a");
  await page.getByText("msg 1-24", { exact: true }).waitFor();
  // Scroll the thread to the bottom — where the sticky bug piled the dates up,
  // and where the last day's header now floats (sticky) over its messages.
  await page.evaluate(() => {
    const t = document.querySelector(".thread");
    if (t) t.scrollTop = t.scrollHeight;
  });
  await page.waitForTimeout(150);
  await expectNoTextOverlaps(page);
});

test("the current day's date stays pinned at the top while scrolling", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/conversations/**/messages**", (r) =>
    r.fulfill({ json: { messages: multiDayThread(), has_more: false, next_before: null } }),
  );
  await page.goto("/?chat=signal:dm:a");
  await page.getByText("msg 0-0", { exact: true }).waitFor();
  // Scroll down within the first (tall) day so its header has scrolled past.
  await page.evaluate(() => {
    const t = document.querySelector(".thread");
    if (t) t.scrollTop = 400;
  });
  await page.waitForTimeout(150);
  // Day 1's header is pinned at the top of the thread (visible, near the top),
  // not scrolled away above it (which would read as a large negative offset).
  const threadTop = await page.locator(".thread").evaluate((e) => e.getBoundingClientRect().top);
  const box = await page.getByText("Thursday, January 1, 2026", { exact: true }).boundingBox();
  expect(box).not.toBeNull();
  const offset = (box?.y ?? -999) - threadTop;
  expect(offset).toBeGreaterThanOrEqual(-2); // still visible at the top, not scrolled off
  expect(offset).toBeLessThan(48); // pinned, not at its in-flow position far down
});
