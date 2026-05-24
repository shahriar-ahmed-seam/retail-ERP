/**
 * Vitest setup for the `unit` project (tests/unit).
 *
 * Unit tests target pure functions, small modules, and renderer components
 * in isolation. They MUST NOT touch the file system, the database, or
 * Electron APIs.
 *
 * The unit project runs under jsdom (see vitest.config.ts) so renderer
 * component tests can mount React trees with `@testing-library/react`. We
 * install the library's `cleanup` between tests here so individual specs
 * don't have to remember it, and import `@testing-library/jest-dom` so the
 * extended matchers (`toBeInTheDocument`, `toHaveValue`, …) are available
 * everywhere.
 */

import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
