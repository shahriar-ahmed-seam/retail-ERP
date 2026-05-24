import * as fc from 'fast-check';

/**
 * Vitest setup for the `property` project (tests/property).
 *
 * Sets fast-check defaults that apply to every property test in this tier:
 *   - numRuns: 200 strikes a balance between coverage and runtime for the
 *     correctness properties listed in design.md (Property 1..16). Individual
 *     properties can override locally via `fc.assert(prop, { numRuns: ... })`.
 *   - verbose: surface the shrunk counter-example clearly on failure.
 *   - endOnFailure: stop on the first failure so the shrunk example is the
 *     last thing printed.
 *
 * Reproducibility: when CI fails with a counter-example, set FAST_CHECK_SEED
 * in the environment to replay the exact run.
 */
const envSeed = process.env.FAST_CHECK_SEED;
const seed = envSeed !== undefined && envSeed !== '' ? Number(envSeed) : undefined;

fc.configureGlobal({
  numRuns: 200,
  verbose: true,
  endOnFailure: true,
  ...(seed !== undefined && Number.isFinite(seed) ? { seed } : {}),
});
