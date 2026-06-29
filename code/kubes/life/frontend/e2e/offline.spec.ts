import { expect, test } from '@playwright/test';

// The app is behind Nextcloud login, but the SHELL (the Angular bundle) loads
// before auth — offline it just shows the sign-in screen. We only assert the
// shell renders, so no login is needed.
test('the app shell loads offline (requires a service worker)', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('app-root')).not.toBeEmpty();

  // The fix: a service worker must install and control the page. With none, this
  // times out — the red that proves offline is broken.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 35_000, // registerWhenStable can take up to 30s
  });

  // …and it must finish prefetching the ENTIRE shell. Going offline mid-prefetch
  // is the race that flakes (the controller goes active first, ~4/15 cached), so
  // wait until the asset cache holds every app-group file listed in ngsw.json.
  await page.waitForFunction(
    async () => {
      const manifest = await (await fetch('/ngsw.json')).json();
      const want = manifest.assetGroups.find((g: { name: string }) => g.name === 'app').urls.length;
      for (const key of await caches.keys()) {
        if (key.includes('assets:app:cache')) {
          return (await (await caches.open(key)).keys()).length >= want;
        }
      }
      return false;
    },
    null,
    { timeout: 60_000 },
  );

  // Cold-load the root with no network: the SW must serve the cached shell, not
  // the browser's offline error page.
  await context.setOffline(true);
  await page.goto('/');

  await expect(page.locator('app-root')).not.toBeEmpty();
  await expect(page.locator('body')).toContainText(/Life/i);
});
