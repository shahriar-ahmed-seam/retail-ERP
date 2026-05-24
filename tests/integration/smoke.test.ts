import { describe, expect, it } from 'vitest';

/**
 * Phase 0 / task 0.5 smoke test for the `integration` tier.
 *
 * Confirms that `npm run test:integration` discovers tests under
 * tests/integration/ with the integration setup file applied. Replaced by
 * real integration tests (DB + Prisma + IPC) as Phases 1+ land.
 */
describe('integration tier smoke', () => {
  it('runs a trivial assertion', () => {
    expect([1, 2, 3].reduce((acc, n) => acc + n, 0)).toBe(6);
  });
});
