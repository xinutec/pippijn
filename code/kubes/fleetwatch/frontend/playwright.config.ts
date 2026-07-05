import { defineConfig, devices } from '@playwright/test';

/**
 * Phone-width layout harness (shared @xinutec/ui-harness). Runs against the
 * real production build served by e2e/serve.mjs. `npm run ui-check`.
 *
 * The viewport lives in the PROJECT `use`, not the global one: a device spread
 * carries its own viewport and project-level `use` overrides global — the exact
 * mistake that once ran life's "phone" tests at 1280×720. The one-line viewport
 * self-guard spec fails loudly if emulation is ever lost again.
 */
const PORT = 4281;

export default defineConfig({
  testDir: './e2e',
  reporter: [['list']],
  timeout: 60_000,
  projects: [{ name: 'chromium', use: { ...devices['Pixel 7'], deviceScaleFactor: 1 } }],
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node e2e/serve.mjs ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
