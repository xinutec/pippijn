import { defineConfig, devices } from '@playwright/test';

/**
 * Config for the harness's OWN fixture specs (tests/), which exercise the
 * measurement functions against page.setContent DOM — no app, no server.
 * Same device convention the consuming apps use, so the fixtures measure at
 * the geometry the real checks run at.
 */
export default defineConfig({
  testDir: './tests',
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { ...devices['Pixel 7'], deviceScaleFactor: 1 } }],
});
