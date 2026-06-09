import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for UI-measurement checks. This is NOT a behavioural
 * test suite — it renders pages in a real browser at a phone viewport and
 * asserts measurable facts about the pixels (no text overlaps, etc.), the
 * thing reading source can't tell you. See e2e/ui-overlap.ts.
 *
 * The app is served by `ng serve`; `reuseExistingServer` means if you
 * already have a dev server up on :4200 it attaches to that instead of
 * spawning another (fast iteration), and starts one in CI/cold runs.
 */
export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	reporter: [["list"]],
	use: {
		baseURL: "http://localhost:4200",
		// iPhone 12-ish portrait — the narrow viewport where the
		// settings-page collisions actually showed up.
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
	},
	projects: [{ name: "mobile-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
	webServer: {
		command: "npm start",
		url: "http://localhost:4200",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
