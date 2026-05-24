import { join } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

/**
 * Phase 0 / task 0.5 smoke test for the `e2e` tier.
 *
 * Launches the built Electron app (`dist/main/index.js`) through Playwright's
 * `_electron` helper, waits for the first BrowserWindow, and asserts the
 * window title matches the value set in `src/renderer/index.html`.
 *
 * If `dist/main/index.js` does not exist (e.g. someone runs E2E before
 * `npm run build`), Electron will fail fast with a clear error message; we
 * intentionally do NOT shell out to `npm run build` here so the E2E command
 * stays fast and deterministic. The Phase 0.7 checkpoint runs `npm run build`
 * first, and CI scripts will mirror that.
 *
 * This is the only E2E test in Phase 0; real flows (login, POS finalize,
 * receipt print fallback) land in Phases 3+ and Phase 16.
 */
const repoRoot = join(__dirname, '..', '..');
const mainEntry = join(repoRoot, 'dist', 'main', 'index.js');

test('packaged Electron app launches and shows the main window', async () => {
  const app = await electron.launch({
    args: [mainEntry],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('Core Retail ERP');
  } finally {
    await app.close();
  }
});
