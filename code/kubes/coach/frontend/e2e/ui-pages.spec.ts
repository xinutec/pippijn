import { expect, test, type Page } from "@playwright/test";
// The fleet-shared harness, published as @xinutec/ui-harness (source repo
// ~/Code/ui-harness). Ships compiled JS, so it loads straight from node_modules.
import {
  expectNoTextOverlaps,
  expectNoHorizontalOverflow,
  expectNoOccludedControls,
  expectViewportIsPhone,
} from "@xinutec/ui-harness";

/**
 * Layout-measurement checks: render coach's screens against the built bundle with
 * the backend mocked, and assert the three layout failure classes that read fine
 * in source and only show in a real browser — text collisions, horizontal
 * overflow, and OCCLUDED controls (a tappable control drawn under a fixed bar).
 * The occlusion check runs at a wide viewport too: the log-a-set FAB sinks behind
 * the bottom nav at ≥768px — invisible at phone width.
 *
 * The service worker is blocked: SW-controlled fetches bypass page.route.
 */
test.use({ serviceWorkers: "block" });

const ME = { userId: "test", displayName: "Test User", avatarUrl: "" };

const SETTINGS = {
  timezone: "Europe/London",
  windowStartHour: 8,
  windowEndHour: 21,
  nightCutoffHour: 21,
  minRestMin: 20,
};

const EXERCISES = [
  { id: 1, slug: "pull_up", name: "Pull-up", equipment: "bar", pattern: "pull", metric: "reps", unilateral: false, isActive: true },
  { id: 6, slug: "ring_dip", name: "Ring dip", equipment: "rings", pattern: "push", metric: "reps", unilateral: false, isActive: true },
  { id: 11, slug: "goblet_squat", name: "Goblet squat", equipment: "weights", pattern: "legs", metric: "weighted_reps", unilateral: false, isActive: true },
];

// A busy "active" verdict so Today renders fully (banner, per-pattern bars,
// suggestion card, the FAB).
const PACING = {
  state: "active",
  weekIndex: 1,
  isDeload: false,
  nudge: true,
  reason: "2 sets of Ring dip — you're a bit behind for today.",
  withinWindow: true,
  afterCutoff: false,
  spacingOk: true,
  minutesSinceLastSet: 33,
  dayRemainingSets: 20,
  weekRemainingSets: 34,
  patterns: [
    { pattern: "push", weekTarget: 10, weekDone: 0, todayTarget: 6, todayDone: 0, todayRemaining: 6 },
    { pattern: "pull", weekTarget: 7, weekDone: 1, todayTarget: 4, todayDone: 1, todayRemaining: 3 },
    { pattern: "legs", weekTarget: 7, weekDone: 0, todayTarget: 4, todayDone: 0, todayRemaining: 4 },
    { pattern: "core", weekTarget: 11, weekDone: 0, todayTarget: 7, todayDone: 0, todayRemaining: 7 },
  ],
  suggestion: { exerciseId: 6, exerciseName: "Ring dip", pattern: "push", sets: 2, repLow: 5, repHigh: 8, loadKg: null, holdS: null },
};

/** Mock every backend call. Catch-all FIRST — Playwright runs handlers
 *  last-registered-first, so the specific routes below win. */
async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/**", (r) =>
    r.request().method() === "GET" ? r.fulfill({ json: [] }) : r.fulfill({ status: 204, body: "" }),
  );
  await page.route("**/api/me", (r) => r.fulfill({ json: ME }));
  await page.route("**/api/pacing/now", (r) => r.fulfill({ json: PACING }));
  await page.route("**/api/exercises*", (r) => r.fulfill({ json: EXERCISES }));
  await page.route("**/api/settings", (r) => r.fulfill({ json: SETTINGS }));
  await page.route("**/api/programs/active", (r) => r.fulfill({ json: null }));
}

test("the suite really runs at phone geometry", async ({ page }) => {
  await mockApi(page);
  await page.goto("/today");
  await expectViewportIsPhone(page);
});

test("today — busy composition: clean + all controls reachable @ phone", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/today");
  await page.getByText("a bit behind for today", { exact: false }).waitFor();
  await page.locator(".add-fab").waitFor();
  await expectNoTextOverlaps(page, testInfo);
  await expectNoHorizontalOverflow(page, testInfo);
  await expectNoOccludedControls(page, testInfo);
});

// Regression: an unauthenticated visitor (no session → /api/me 401s) must get a
// visible way in. The app once swallowed the 401 and rendered empty chrome with
// no login affordance and no redirect — "where is the login?". Now it shows a
// sign-in card that links to /login (→ Nextcloud OAuth).
test("signed-out — the sign-in card offers a way in @ phone", async ({ page }, testInfo) => {
  await page.route("**/api/me", (r) => r.fulfill({ status: 401, json: {} }));
  await page.goto("/today");
  const signIn = page.getByRole("link", { name: "Sign in with Nextcloud" });
  await signIn.waitFor();
  await expect(signIn).toHaveAttribute("href", "/login");
  await expectNoTextOverlaps(page, testInfo);
  await expectNoHorizontalOverflow(page, testInfo);
});

test("settings — clean + reachable @ phone", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Check for updates" }).waitFor();
  await expectNoTextOverlaps(page, testInfo);
  await expectNoHorizontalOverflow(page, testInfo);
  await expectNoOccludedControls(page, testInfo);
});

// The FAB-under-nav bug lives at ≥768px (tablet/landscape), where the phone
// suite is blind. Same page, wide viewport, occlusion assertion.
test.describe("wide viewport (tablet/landscape)", () => {
  test.use({ viewport: { width: 1024, height: 800 } });

  test("today — the FAB is not occluded by the bottom nav @ 1024px", async ({ page }, testInfo) => {
    await mockApi(page);
    await page.goto("/today");
    await page.locator(".add-fab").waitFor();
    await expectNoOccludedControls(page, testInfo);
  });
});
