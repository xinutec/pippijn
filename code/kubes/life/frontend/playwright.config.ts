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
  // SW registration + full prefetch can take a while on a cold headless run, and
  // the in-test waits run up to 60s; keep the per-test budget above them.
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 390, height: 844 },
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
