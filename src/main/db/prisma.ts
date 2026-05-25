// src/main/db/prisma.ts
//
// Configured Prisma client wrapper for Core Retail ERP V1 (Phase 1, task 1.3).
//
// Responsibilities:
//   1. Export a single, process-wide `PrismaClient` instance. The singleton is
//      cached on `globalThis` so that Vite/electron-vite HMR reloads of the
//      main process do not leak duplicate clients (each new `PrismaClient`
//      opens its own connection pool against shop.db).
//   2. Apply the SQLite PRAGMA configuration required by Req 16.11 on every
//      physical connection: WAL journal mode, NORMAL synchronous, foreign
//      keys ON, a 5s busy timeout, and a 1000-page WAL autocheckpoint.
//      The pragmas are applied lazily via `connect()`; callers that just
//      `import { prisma }` and immediately `await prisma.$transaction(...)`
//      should call `connect()` first during application bootstrap so the
//      pragmas are in effect before the first business write.
//   3. Provide an `disconnect()` helper for clean shutdown (`app.before-quit`)
//      and for tests that need to release the database file handle.
//   4. Expose `runWeeklyMaintenance()` as the entry point for the weekly
//      `VACUUM` + `ANALYZE` job (Req 16.10). Phase 11 task 11.2 wires the
//      cron scheduler that calls this function; isolating the work here
//      keeps it unit-testable independently of the scheduler.
//
// The wrapper deliberately does NOT swallow errors: callers (services and
// the IPC router middleware) translate Prisma exceptions into the
// `ErrorEnvelope` codes defined in design.md. This module's job is to set
// up the connection correctly and stay out of the way.

import { PrismaClient } from '@prisma/client';

/**
 * SQLite PRAGMA statements applied on every connection.
 *
 * - `journal_mode=WAL` enables write-ahead logging so readers and the single
 *   writer do not block each other (design.md "WAL mode is the rationale...").
 * - `synchronous=NORMAL` is the recommended pairing with WAL: durable on
 *   commit-to-WAL, with checkpoints fsync'd, without the per-write fsync of
 *   `FULL`.
 * - `foreign_keys=ON` is required for Prisma's referential integrity to work
 *   on SQLite (Req 15.2). SQLite defaults this OFF per connection; it must be
 *   re-enabled every time a new connection is opened.
 * - `busy_timeout=5000` makes contended writers wait up to 5 seconds for the
 *   write lock instead of failing immediately, which matters under POS bursts.
 * - `wal_autocheckpoint=1000` is the primary WAL bound (Req 16.11): SQLite
 *   passively checkpoints after every 1000 committed pages, inline with
 *   normal writes, so cashiers never see a checkpoint pause.
 *
 * Frozen so callers cannot mutate the list at runtime.
 */
export const PRAGMA_STATEMENTS: readonly string[] = Object.freeze([
  'journal_mode=WAL',
  'synchronous=NORMAL',
  'foreign_keys=ON',
  'busy_timeout=5000',
  'wal_autocheckpoint=1000',
]);

/**
 * Internal cache shape kept on `globalThis` so HMR reloads reuse the same
 * client + pragma state. `pragmasApplied` is reset to `false` whenever the
 * underlying connection is closed (`disconnect()`), so the next `connect()`
 * re-applies the PRAGMAs on the freshly-opened connection.
 */
interface PrismaCache {
  client: PrismaClient;
  pragmasApplied: boolean;
}

/**
 * Type-safe handle on `globalThis` for the Prisma cache slot. Using a
 * branded property name (`__coreRetailErpPrisma`) avoids collisions with
 * other globals that might be set by Electron, test runners, or future
 * native modules.
 */
const globalForPrisma = globalThis as typeof globalThis & {
  __coreRetailErpPrisma?: PrismaCache;
};

/**
 * Build a fresh `PrismaClient`. The log level is intentionally narrow:
 *   - In development we surface `warn` and `error` so connection-level
 *     issues (slow queries, unhealthy connection pools) are visible without
 *     drowning the console in per-query traces.
 *   - In production we only surface `error` to avoid noisy logs in the
 *     packaged installer's userData log directory.
 */
function createPrismaClient(): PrismaClient {
  const isDev = process.env.NODE_ENV === 'development';
  return new PrismaClient({
    log: isDev ? ['warn', 'error'] : ['error'],
  });
}

const cache: PrismaCache = globalForPrisma.__coreRetailErpPrisma ?? {
  client: createPrismaClient(),
  pragmasApplied: false,
};

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__coreRetailErpPrisma = cache;
}

/**
 * The process-wide `PrismaClient` singleton. Import this in services and
 * IPC handlers; do NOT construct additional `PrismaClient` instances
 * elsewhere in the main process.
 */
export const prisma: PrismaClient = cache.client;

/**
 * Apply each `PRAGMA_STATEMENTS` entry against the open connection.
 * Sequential, not parallel: PRAGMAs are connection-scoped state and we want
 * deterministic ordering for diagnostics.
 */
async function applyPragmas(client: PrismaClient): Promise<void> {
  for (const statement of PRAGMA_STATEMENTS) {
    // `$queryRawUnsafe` is used (not `$executeRawUnsafe`) because some
    // SQLite PRAGMAs echo their result as a row — `journal_mode=WAL`
    // returns the new mode (`'wal'`), which `$executeRawUnsafe` rejects
    // with "Execute returned results, which is not allowed in SQLite."
    // `$queryRawUnsafe` accepts both row-returning and rowless statements
    // so the same loop handles every PRAGMA in `PRAGMA_STATEMENTS`.
    //
    // PRAGMA names are not bindable parameters in SQLite. The statement
    // list is a frozen module-level constant, never user input, so there
    // is no injection surface.
    await client.$queryRawUnsafe(`PRAGMA ${statement};`);
  }
}

/**
 * Open the underlying SQLite connection (if not already open) and apply the
 * PRAGMA configuration. Idempotent: subsequent calls within the same
 * connection lifetime are no-ops. Call once during main-process bootstrap
 * before any business transaction runs.
 *
 * @returns the same singleton `prisma` client, for fluent use at the
 *   bootstrap call site.
 */
export async function connect(): Promise<PrismaClient> {
  await prisma.$connect();
  if (!cache.pragmasApplied) {
    await applyPragmas(prisma);
    cache.pragmasApplied = true;
  }
  return prisma;
}

/**
 * Close the underlying SQLite connection. Used on `app.before-quit` and in
 * tests that need to release the database file handle (e.g. before deleting
 * the test database file). The pragma-applied flag is reset so a subsequent
 * `connect()` re-installs the PRAGMAs on the new physical connection
 * (Req 16.11 — pragmas are per-connection state).
 */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
  cache.pragmasApplied = false;
}

/**
 * Weekly maintenance entry point — `VACUUM` and `ANALYZE` (Req 16.10).
 *
 * - `VACUUM` reclaims free pages and keeps the database file compact.
 *   It briefly takes an exclusive write lock and is therefore intended to
 *   run outside business hours; the cron schedule lives in Phase 11
 *   (task 11.2). This function is the unit-testable seam the scheduler
 *   calls.
 * - `ANALYZE` refreshes SQLite's query-planner statistics so paginated
 *   list endpoints keep hitting the right covering indexes as the data
 *   distribution evolves over months/years of operation (Req 12.4, 16.9).
 *
 * Both statements are streaming at the SQLite engine level, so memory use
 * stays bounded by SQLite's page cache rather than by the database size
 * (Req 16.7).
 *
 * The function ensures the connection is open + PRAGMAs applied before
 * running so the scheduler can call it safely without an explicit
 * `connect()` first.
 */
export async function runWeeklyMaintenance(): Promise<void> {
  await connect();
  // Statements are issued separately because SQLite does not run multi-
  // statement strings via the Prisma raw API, and because separating them
  // gives the scheduler clearer error attribution if one fails.
  await prisma.$executeRawUnsafe('VACUUM;');
  await prisma.$executeRawUnsafe('ANALYZE;');
}
