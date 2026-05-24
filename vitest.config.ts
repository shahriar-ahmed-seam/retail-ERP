import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Vitest workspace configuration for the three non-E2E test tiers.
 *
 * Tiers (per design.md "Testing strategy" + tasks.md task 0.5):
 *   - unit:        Pure-function and component-level tests under tests/unit
 *   - integration: Multi-module / DB-touching tests under tests/integration
 *   - property:    fast-check property tests under tests/property
 *
 * E2E tests live under tests/e2e and are run by Playwright (playwright.config.ts),
 * not Vitest, so we explicitly exclude that path from every project.
 *
 * Each project gets its own setup file so DB / fast-check / DOM concerns can
 * diverge as later phases add fixtures without polluting the others.
 */
const sharedAlias = {
  '@main': resolve(__dirname, 'src/main'),
  '@preload': resolve(__dirname, 'src/preload'),
  '@renderer': resolve(__dirname, 'src/renderer'),
  '@shared': resolve(__dirname, 'src/shared'),
};

const sharedExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/out/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  'tests/e2e/**',
];

export default defineConfig({
  resolve: {
    alias: sharedAlias,
  },
  test: {
    projects: [
      {
        resolve: { alias: sharedAlias },
        plugins: [react()],
        test: {
          name: 'unit',
          // jsdom is required for renderer component tests (task 3.3
          // onward). Pure-function tests under tests/unit/main and
          // tests/unit/shared run fine in jsdom too — `globalThis` is a
          // superset of node's, and these tests don't depend on
          // node-only APIs.
          environment: 'jsdom',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
          exclude: sharedExclude,
          setupFiles: ['tests/unit/setup.ts'],
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.{ts,tsx}'],
          exclude: sharedExclude,
          setupFiles: ['tests/integration/setup.ts'],
          // Integration tests touch the file system / DB; keep them serial by
          // default to avoid SQLite write contention. Individual suites can
          // opt into concurrency once they are isolated.
          fileParallelism: false,
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'property',
          environment: 'node',
          include: ['tests/property/**/*.{property,test}.{ts,tsx}'],
          exclude: sharedExclude,
          setupFiles: ['tests/property/setup.ts'],
          // Property tests can run long; bump the per-test timeout. Individual
          // properties can override via `testTimeout` in their own describe.
          testTimeout: 30_000,
        },
      },
    ],
  },
});
