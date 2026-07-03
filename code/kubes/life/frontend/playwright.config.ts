import { defineConfig, devices } from '@playwright/test';

/**
 * e2e harness for the things jsdom can't see — currently: does the app load
 * OFFLINE? That's service-worker behaviour, so the test runs against the real
 * PRODUCTION build (the SW only ships in `ng build`), served statically by
 * e2e/serve.mjs. Run with `npm run e2e` (builds, then runs).
 *
 * Tests live in e2e/ (outside src/), so the vitest unit runner ignores them.
 */
const PORT = 4271;

export default defineConfig({
  testDir: './e2e',
  reporter: [['list']],
  // Golden screenshots (e2e/ui-golden.spec.ts). One committed baseline per
  // name — no {projectName}/{platform} suffix, because these only ever run on
  // one machine (a dev's Mac; CI runs Rust only, never Playwright — see
  // .github/workflows/build.yml). Update them with `npm run ui-golden:update`.
  snapshotPathTemplate: 'e2e/__screenshots__/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      // A hair of tolerance for sub-pixel antialiasing seams; a real visual
      // change moves far more than 1% of the pixels.
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  // SW registration + full prefetch can take a while on a cold headless run, and
  // the in-test waits run up to 60s; keep the per-test budget above them.
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
  },
  // Emulate the phone this app is actually used on (Pixel 9 ≈ the Pixel 7
  // preset: 412 CSS px wide, mobile UA, touch). The viewport MUST live here in
  // the project's `use`, not the global one: a device spread carries its own
  // viewport, and project-level `use` overrides global — which is exactly how
  // an earlier `...devices['Desktop Chrome']` here silently ran every "phone
  // width" test at 1280×720. deviceScaleFactor is forced to 1 so golden PNGs
  // stay small; CSS-pixel geometry (what the layout checks measure) is
  // identical at any DPR.
  projects: [{ name: 'chromium', use: { ...devices['Pixel 7'], deviceScaleFactor: 1 } }],
  webServer: {
    // serve.mjs serves dist/life-web/browser; `npm run e2e` builds it first.
    // reuseExistingServer: attach to a serve.mjs you started yourself if one is
    // up (handy on macOS, where spawning extra node procs trips a libuv/kqueue
    // crash) — else Playwright starts one.
    command: `node e2e/serve.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
