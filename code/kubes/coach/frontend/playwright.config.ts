import { defineConfig, devices } from "@playwright/test";

/**
 * Layout harness (L2 of dev-lint/docs/layout-quality-architecture.md): render the
 * production build in a real browser at true device geometry and assert about the
 * painted pixels — text overlap, horizontal overflow, and occluded controls (a
 * control drawn under a fixed bar, the coach FAB-under-nav bug). The SW ships only
 * in `ng build`, so it runs against the built bundle served by e2e/serve.mjs.
 *
 * Tests live in e2e/ (outside src/), so the vitest unit runner ignores them.
 */
const PORT = 4281;

export default defineConfig({
  testDir: "./e2e",
  reporter: [["list"]],
  timeout: 90_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: "only-on-failure",
  },
  // Pixel 7 preset (412 CSS px, mobile UA, touch). The viewport MUST live in the
  // project's `use` (a device spread carries its own viewport and project-level
  // `use` overrides global) — the checker-checker guards against it silently
  // dropping. The wide-viewport occlusion case overrides this per-describe.
  projects: [{ name: "chromium", use: { ...devices["Pixel 7"], deviceScaleFactor: 1 } }],
  webServer: {
    // reuseExistingServer: attach to a serve.mjs you started yourself if one is up
    // (handy on macOS, where spawning extra node procs can trip a libuv/kqueue
    // crash) — else Playwright starts one. `npm run ui-check` builds first.
    command: `node e2e/serve.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
