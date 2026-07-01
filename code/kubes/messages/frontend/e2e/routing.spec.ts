import { expect, test, type Page } from "@playwright/test";

/**
 * The router contract: navigation state lives in the URL, so it's bookmarkable/
 * shareable, survives refresh, and the browser Back button works. The open
 * conversation is a real route — `/c/:origin/:id` — and the origin filter and
 * paged-back depth are query params (`?origin` / `?from`). Behavioural, because
 * "is the router used correctly?" is a render/navigation fact a static rule
 * can't see.
 */

const ME = { user_id: "pippijn", display_name: "Pippijn van Steenhoven" };
const CONVERSATIONS = [
  { origin: "signal", id: "dm:a", name: "Alice", kind: "dm", message_count: 5, last_ts: 1_717_000_000_000 },
  { origin: "gchat", id: "gc1", name: "Bob", kind: "dm", message_count: 3, last_ts: 1_717_100_000_000 },
];
const MESSAGES_PAGE = {
  messages: [
    { id: "1", ts: 1_717_000_000_000, sender: "Alice", is_outgoing: false, body: "hi", deleted: false, edited: false, reactions: [], attachments: [] },
  ],
  has_more: false,
  next_before: null,
};

async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("**/api/me", (r) => r.fulfill({ json: ME }));
  await page.route("**/api/conversations", (r) => r.fulfill({ json: CONVERSATIONS }));
  await page.route("**/api/conversations/**/messages**", (r) => r.fulfill({ json: MESSAGES_PAGE }));
}

test("origin filter is reflected in the URL", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  // exact: the filter button's name is exactly "Google Chat"; a gchat
  // conversation row also contains "Google Chat" in its subtitle.
  await page.getByRole("button", { name: "Google Chat", exact: true }).click();
  await expect(page).toHaveURL(/[?&]origin=gchat\b/);
});

test("opening a conversation is reflected in the URL", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Alice/ }).click();
  await expect(page).toHaveURL(/\/c\/signal\/dm:a/);
});

test("deep-linking an origin filter restores it on load", async ({ page }) => {
  await mockApi(page);
  await page.goto("/?origin=gchat");
  await page.getByText("Bob").waitFor();
  // Signal conversations are filtered out, so Alice must not be listed.
  await expect(page.getByText("Alice")).toHaveCount(0);
});

function m(ts: number, body: string) {
  return { id: String(ts), ts, sender: "s", is_outgoing: false, body, deleted: false, edited: false, reactions: [], attachments: [] };
}

// Paged mock: the recent page (no `before`) has more; one older page below it.
async function mockApiPaged(page: Page): Promise<void> {
  await page.route("**/api/**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("**/api/me", (r) => r.fulfill({ json: ME }));
  await page.route("**/api/conversations", (r) => r.fulfill({ json: CONVERSATIONS }));
  await page.route("**/api/conversations/**/messages**", (route) => {
    // Distinct bodies that don't substring-collide with UI text like
    // "Load older messages" (getByText is case-insensitive substring).
    const before = new URL(route.request().url()).searchParams.get("before");
    if (before) {
      route.fulfill({ json: { messages: [m(1000, "antiquemsg")], has_more: false, next_before: null } });
    } else {
      route.fulfill({ json: { messages: [m(2000, "freshmsg")], has_more: true, next_before: 2000 } });
    }
  });
}

test("loading older messages is reflected in the URL", async ({ page }) => {
  await mockApiPaged(page);
  await page.goto("/c/signal/dm:a");
  await page.getByText("freshmsg", { exact: true }).waitFor();
  await page.getByRole("button", { name: /Load older/ }).click();
  await page.getByText("antiquemsg", { exact: true }).waitFor();
  await expect(page).toHaveURL(/[?&]from=1000\b/);
});

test("reloading restores the older messages that were paged in", async ({ page }) => {
  await mockApiPaged(page);
  await page.goto("/c/signal/dm:a?from=1000"); // as if reloaded after paging
  await page.getByText("antiquemsg", { exact: true }).waitFor(); // restored, no click
  await page.getByText("freshmsg", { exact: true }).waitFor();
});

test("Back returns from a conversation to the list", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Alice/ }).click();
  await expect(page).toHaveURL(/\/c\/signal\/dm:a/);
  await page.goBack();
  await expect(page).not.toHaveURL(/\/c\//);
  await page.getByPlaceholder("Search messages").waitFor();
});
