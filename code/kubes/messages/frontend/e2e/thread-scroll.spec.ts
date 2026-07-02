import { expect, test, type Page } from "@playwright/test";

/**
 * Opening a conversation must land at the LATEST message (the bottom), like any
 * chat app — not at the top of the fetched page. `Thread.loadThread` calls
 * `scrollToBottom()` on open when there's no `?from`; this asserts the rendered
 * result actually sits at the bottom in a real browser. Only a render check can
 * see this: jsdom has no scroll geometry (scrollHeight/clientHeight are 0), so
 * vitest can't tell "pinned to bottom" from "pinned to top".
 */

const ME = { user_id: "u1", display_name: "Test User" };
const CONVERSATIONS = [
  { origin: "signal", id: "dm:a", name: "Alice", kind: "dm", message_count: 1000, last_ts: 1_717_000_000_000 },
];

function m(ts: number, body: string) {
  return { id: String(ts), ts, sender: "Alice", is_outgoing: false, body, deleted: false, edited: false, reactions: [], attachments: [] };
}

// One full server page (PAGE=100 in thread.ts) of the newest messages, ascending
// by ts — far taller than the 844px viewport — with older history available.
// This is the "tap a long chat" case: the fetched page is the newest slice.
function newestPage(n: number) {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  return Array.from({ length: n }, (_, k) => m(base + k * 60_000, `msg${k}`));
}

async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("**/api/me", (r) => r.fulfill({ json: ME }));
  await page.route("**/api/conversations", (r) => r.fulfill({ json: CONVERSATIONS }));
  await page.route("**/api/conversations/**/messages**", (route) => {
    const before = new URL(route.request().url()).searchParams.get("before");
    // Newest page (no `before`); opening at the bottom needs only this page.
    // Older history exists (has_more) but is fetched lazily on scroll-up.
    if (before) {
      route.fulfill({ json: { messages: [], has_more: false, next_before: null } });
    } else {
      route.fulfill({ json: { messages: newestPage(100), has_more: true, next_before: 1_000_000 } });
    }
  });
}

test("opening a long conversation lands at the latest message", async ({ page }) => {
  await mockApi(page);
  await page.goto("/conversation/signal/dm:a");
  // The newest message (last of the page) is what we should be looking at.
  await page.getByText("msg99", { exact: true }).waitFor();
  await page.waitForTimeout(150); // let the load's scrollToBottom settle

  const geom = await page.locator(".thread").evaluate((t) => ({
    distanceFromBottom: t.scrollHeight - t.scrollTop - t.clientHeight,
    scrollTop: t.scrollTop,
  }));
  // Pinned to the bottom (within a small epsilon) ...
  expect(geom.distanceFromBottom).toBeLessThanOrEqual(4);
  // ... and it genuinely scrolled — proving it's a long thread that landed at the
  // end, not a short one that trivially fits (which would pass a bottom check for
  // free).
  expect(geom.scrollTop).toBeGreaterThan(0);

  // The newest bubble is actually within the viewport.
  const lastInView = await page.getByText("msg99", { exact: true }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight + 1;
  });
  expect(lastInView).toBe(true);

  // And the oldest rendered bubble is scrolled off the top (it opened at the end,
  // not the start).
  const firstAboveViewport = await page
    .getByText("msg0", { exact: true })
    .evaluate((el) => el.getBoundingClientRect().bottom < 0);
  expect(firstAboveViewport).toBe(true);
});
