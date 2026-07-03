# ui-harness — shared phone-width layout checks (Playwright)

The fleet's dynamic layout-measurement layer (L2 of
`dev-lint/docs/layout-quality-architecture.md`): render a screen at true
phone geometry and assert about the **painted pixels**, not the source.
Extracted from the life app's e2e harness after it caught, in one week: a
497px toggle row in a 380px sheet, nested scrollers that broke swipe, and a
suite that had silently run at 1280×720 while claiming 390px.

## Consuming (per app)

Playwright transpiles TypeScript anywhere **outside node_modules**, so apps
import the sources by relative path — no package install, no lockfile churn,
one shared implementation:

```ts
// frontend/e2e/ui-pages.spec.ts
import { expectNoTextOverlaps, expectNoHorizontalOverflow } from '../../../ui-harness/src/ui-harness';
```

Config convention (the viewport MUST live in the project `use`, not the
global one — a device spread carries its own viewport and project-level
`use` overrides global; that exact mistake ran life's "phone" tests at
desktop width for months):

```ts
projects: [{ name: 'chromium', use: { ...devices['Pixel 7'], deviceScaleFactor: 1 } }],
snapshotPathTemplate: 'e2e/__screenshots__/{arg}{ext}',
expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' } },
```

Every app's suite includes one viewport self-guard spec:

```ts
test('the suite really runs at phone geometry', async ({ page }) => {
  await page.goto('/');
  await expectViewportIsPhone(page);
});
```

## API

- `expectNoTextOverlaps(page, testInfo, rootSel?, tol?)` — no two pieces of
  painted text share pixels. Glyph-level (`Range.getClientRects()`), with the
  paint model: rects are clipped to every overflow-clipping ancestor and
  same-node fragment pairs are skipped (ellipsized nowrap text emits phantom
  full-width rects otherwise).
- `expectNoHorizontalOverflow(page, testInfo, rootSel?, allow?, tol?)` —
  nothing spills past the right edge of the viewport (or `rootSel`).
  Intended horizontal scrollers are an **explicit allow-list**; computed
  `overflow-x` is a trap (`overflow-y:auto` forces it to `auto`, exempting
  whole subtrees).
- `expectViewportIsPhone(page, width?)` — the checker-checker: fails the
  suite loudly if device emulation ever silently drops.
- `swipeUp(page, opts?)` — a real CDP touch flick (touchStart → moves →
  touchEnd), not a scrollTop shortcut: it proves the gesture works.
- `expectReachableByScroll(page, locator, scrollerSel)` — swipe until the
  target's bottom is on-screen and the scroller is clamped; fails if a
  nested-scroller fight (or anything else) keeps it unreachable.
- `leaveSnapshot(page, testInfo)` — full-page PNG under `ui-snapshots/`
  (gitignored), pass or fail, so the human eye-check is always one click.

## Self-tests

`npm install && npm test` here runs the package's own fixture specs
(`page.setContent` DOM fixtures — no app server): the ellipsis-phantom and
clip-model false-positive cases, real overlap/overflow detection, and the
allow-list. Run them after any change to the measurement functions — five
apps consume this file.
