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
