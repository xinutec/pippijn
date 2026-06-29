import { test, type Page } from "@playwright/test";
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

// A thread spanning several days, long enough to scroll. The date separators
// must not pile up on each other at the top when scrolled (the sticky-stacking
// bug). 4 days × 12 messages → 4 separators + plenty of scroll height.
function multiDayThread() {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  const out = [];
  for (let d = 0; d < 4; d++) {
    for (let k = 0; k < 12; k++) {
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
  await page.getByText("msg 3-11", { exact: true }).waitFor();
  // Scroll the thread to the bottom — where the sticky bug piled the dates up.
  await page.evaluate(() => {
    const t = document.querySelector(".thread");
    if (t) t.scrollTop = t.scrollHeight;
  });
  await page.waitForTimeout(150);
  await expectNoTextOverlaps(page);
});
