import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

/**
 * Phase 0 / task 0.5 smoke test for the `property` tier.
 *
 * Confirms that `npm run test:property` discovers tests under tests/property/
 * AND that fast-check is wired in correctly via the tier's setup file.
 * Replaced by real correctness properties (Property 1..16 in design.md) in
 * later phases.
 */
describe('property tier smoke', () => {
  it('addition is commutative over integers', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        expect(a + b).toBe(b + a);
      }),
      // Keep the smoke run cheap so CI startup is fast; the global default of
      // 200 runs from tests/property/setup.ts applies to real properties.
      { numRuns: 50 },
    );
  });
});
