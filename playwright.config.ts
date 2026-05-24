import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the E2E tier (task 0.5).
 *
 * Per design.md "Testing strategy", E2E tests target the *packaged* Electron
 * application — for V1 that means launching the built artifacts at
 * `dist/main/index.js` via Playwright's `_electron.launch()` helper. Tests
 * themselves live under `tests/e2e/` and are written with `@playwright/test`
 * + the experimental `electron` test fixture.
 *
 * The full installer-driven smoke (electron-builder + signed installer) is
 * exercised in Phase 16; until then `dist/main/index.js` produced by
 * `electron-vite build` is the closest equivalent of a packaged app.
 *
 * Convention: every E2E test file ends in `*.e2e.spec.ts` so that a casual
 * `vitest` invocation ignores them (the Vitest config also explicitly
 * excludes `tests/e2e/**`).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.e2e\.spec\.ts$/,
  // E2E tests serialize because Electron windows are heavyweight and the
  // SQLite database is single-writer.
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  // Generous timeout — Electron cold-start on Windows can be slow.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
