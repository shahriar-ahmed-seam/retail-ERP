/**
 * Vitest setup for the `integration` project (tests/integration).
 *
 * Integration tests exercise multiple modules together and may open a SQLite
 * database, hit the Prisma client, or run an in-process IPC router. Heavy
 * fixtures (per-test temp DB, migration apply, seed) are wired here in later
 * phases (see tasks 1.6, 3.6, 6.4).
 *
 * Suppresses the post-commit receipt printer (Phase 8 task 8.5) so
 * integration tests do not write tmp PDF files for every sale finalize.
 * The flag is read by `postCommitPrint` in `src/main/printing/printer.ts`;
 * setting it here keeps the env mutation scoped to the integration tier.
 */

process.env.SUPPRESS_RECEIPT_PRINTING = '1';

export {};
