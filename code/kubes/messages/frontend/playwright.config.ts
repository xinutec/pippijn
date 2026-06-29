import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright UI-render checks. NOT behavioural tests — they render the app in a
 * real browser at a phone viewport and assert measurable facts about the pixels
 * (icon fonts actually load; no text overlaps another's pixels). This is the
 * layer unit tests can't be: jsdom has no fonts or layout, so a mat-icon that
 * silently falls back to its ligature word ("search") reads green in vitest and
 * only the render disagrees. See e2e/ui-overlap.ts.
 *
 * The app is served by `ng serve`; `reuseExistingServer` attaches to a dev
 * server already on :4200, else starts one (CI/cold runs).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4200",
    viewport: { width: 390, height: 844 }, // iPhone-ish portrait
    deviceScaleFactor: 2,
  },
  projects: [
    { name: "mobile-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm start",
    url: "http://localhost:4200",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
