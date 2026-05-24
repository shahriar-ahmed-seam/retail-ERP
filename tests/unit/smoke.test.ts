import { describe, expect, it } from 'vitest';

/**
 * Phase 0 / task 0.5 smoke test for the `unit` tier.
 *
 * Confirms that `npm run test:unit` discovers tests under tests/unit/ and that
 * the runner can execute a trivial assertion. Replaced by real unit tests as
 * services land in Phases 2+.
 */
describe('unit tier smoke', () => {
  it('runs a trivial assertion', () => {
    expect(1 + 1).toBe(2);
  });
});
