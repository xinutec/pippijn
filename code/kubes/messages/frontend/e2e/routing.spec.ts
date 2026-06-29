import { expect, test, type Page } from "@playwright/test";

/**
 * The router contract: navigation state (origin filter, open conversation) lives
 * in the URL, so it's bookmarkable/shareable, survives refresh, and the browser
 * Back button works. Written TDD-first — these FAIL until query-param routing is
 * wired (today the app holds that state in component signals and the URL never
 * leaves `/`). Behavioural, because "is the router used correctly?" is a render/
 * navigation fact a static rule can't see.
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
  await expect(page).toHaveURL(/[?&]chat=/);
});

test("deep-linking an origin filter restores it on load", async ({ page }) => {
  await mockApi(page);
  await page.goto("/?origin=gchat");
  await page.getByText("Bob").waitFor();
  // Signal conversations are filtered out, so Alice must not be listed.
  await expect(page.getByText("Alice")).toHaveCount(0);
});

test("Back returns from a conversation to the list", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Alice/ }).click();
  await expect(page).toHaveURL(/[?&]chat=/);
  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]chat=/);
  await page.getByPlaceholder("Search messages").waitFor();
});
