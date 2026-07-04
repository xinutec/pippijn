import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright UI-render checks — NOT a behavioural suite. They render the app in
 * a real browser at true phone geometry and assert measurable facts about the
 * pixels (no text overlaps, nothing overflows the width). jsdom has no fonts or
 * layout, so a collision that reads fine in source only shows in the render.
 * Shared checkers live in code/kubes/ui-harness; see
 * dev-lint/docs/layout-quality-architecture.md.
 *
 * Runs against the PRODUCTION build served statically by e2e/serve.mjs — one
 * device, identical to life/fleetwatch/messages/health. `npm run ui-check`
 * (wired into verify.sh after `ng build`) serves the freshly-built dist;
 * reuseExistingServer attaches to a serve.mjs already up.
 */
const PORT = 4274;

export default defineConfig({
  testDir: './e2e',
  reporter: [['list']],
  snapshotPathTemplate: 'e2e/__screenshots__/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
  },
  // Emulate the phone this app is actually used on (Pixel 9 ≈ the Pixel 7
  // preset: 412 CSS px wide, mobile UA, touch). The viewport MUST live in the
  // PROJECT `use`, not the global one: a device spread carries its own viewport,
  // and project-level `use` overrides global. deviceScaleFactor forced to 1 so
  // CSS-pixel geometry (what the layout checks measure) is DPR-invariant.
  projects: [{ name: 'chromium', use: { ...devices['Pixel 7'], deviceScaleFactor: 1 } }],
  webServer: {
    command: `node e2e/serve.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
