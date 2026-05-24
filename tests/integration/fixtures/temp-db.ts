// tests/integration/fixtures/temp-db.ts
//
// Per-test temp SQLite database fixture (Phase 6, task 6.4).
//
// The integration tier needs a real Prisma + SQLite environment so it can
// observe the atomicity guarantees in design.md > "Atomicity boundaries"
// (Req 11.x). This helper is the canonical way to obtain one. It:
//
//   1. Allocates a unique SQLite file under `os.tmpdir()` so each test
//      runs against its own database — no cross-test bleed-through, no
//      need to reset state between tests within a file, no contention
//      with the dev `prisma/dev.db`.
//
//   2. Sets `process.env.DATABASE_URL` to that file BEFORE the
//      `@main/db/prisma.js` singleton module is loaded. The singleton
//      reads `DATABASE_URL` at client-construction time only (Phase 1,
//      task 1.3), so the env mutation has to land first.
//
//   3. Spawns `prisma migrate deploy` and `prisma db seed`
//      synchronously against the test DATABASE_URL. Same shell-handling
//      and error-checking pattern as `scripts/build-db-template.ts`
//      (Windows `.cmd` shim handling, env passthrough, hard fail on
//      non-zero exit).
//
//   4. Resets Vitest's module cache (`vi.resetModules()`) and clears
//      the singleton's `globalThis` cache slot
//      (`__coreRetailErpPrisma`) so the next dynamic import of
//      `@main/db/prisma.js` constructs a fresh `PrismaClient` against
//      the per-test DATABASE_URL rather than handing out the previous
//      test's stale client.
//
//   5. Dynamic-imports `@main/db/prisma.js` and applies the
//      foreign-keys + busy-timeout PRAGMAs (Req 16.11) directly via
//      `$queryRawUnsafe`. The production-side `connect()` helper uses
//      `$executeRawUnsafe`, which rejects PRAGMA statements that
//      return result rows (e.g. `journal_mode=WAL` echoes the new
//      mode). Bypassing `connect()` here keeps this fixture free of
//      that limitation; production behaviour is out of scope for this
//      task ("Do NOT modify the production code"). The crucial
//      pragma for this test tier is `foreign_keys=ON` — without it
//      SQLite skips FK enforcement and the `FK_VIOLATION` assertion
//      in the atomicity test cannot fire.
//
//   6. Dynamic-imports the requested service modules (currently
//      `purchase.service` and `pos.service`) so they pick up the same
//      fresh singleton. Tests use the returned references rather than
//      top-level static imports.
//
//      ────────────────────────────────────────────────────────────
//      Adding a new service to the fixture: the fixture must hand
//      back service references that bind to the per-test Prisma
//      singleton. To expose another service, dynamic-import the
//      module AFTER `vi.resetModules()` + the `globalThis` slot
//      delete (Step 4) and AFTER `prisma.$connect()` (Step 5), then
//      surface the import on the returned `TempDbFixture` shape with
//      a typed re-export. Static `import { Foo } from '...'` lines at
//      the top of this file are types-only — they pin the public
//      surface — and the *runtime* binding always comes from the
//      dynamic import inside `createTempDb`. Mirror the
//      `PurchaseService` pattern below.
//      ────────────────────────────────────────────────────────────
//
//   7. Returns `{ prisma, services, cleanup }` where `cleanup()`
//      disconnects the client, deletes the `.db` and its `-journal /
//      -wal / -shm` sidecars, and restores the previous
//      `DATABASE_URL`. Tests run `cleanup()` from `afterEach`.
//
// THE FIXTURE IS THE ONLY PLACE THAT TALKS TO THE PRISMA CLI. Test
// files just call it and write business assertions.
//
// Validates: Requirements 5.1, 5.5, 11.2 (test infrastructure for
//            purchase atomicity assertions).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import type { CustomerService } from '@main/services/customer.service';
import type { POSService } from '@main/services/pos.service';
import type { PurchaseService } from '@main/services/purchase.service';
import type { ReportService } from '@main/services/report.service';
import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * What `createTempDb` returns to the test. Tests use `prisma` for
 * direct seeding and assertions, the freshly-imported service
 * references for the code under test, and `cleanup` for teardown.
 */
export interface TempDbFixture {
  /** Fresh Prisma client bound to the per-test SQLite file with WAL +
   *  foreign-keys PRAGMAs already applied. */
  readonly prisma: PrismaClient;
  /** Re-imported `PurchaseService` instance bound to `prisma`. */
  readonly PurchaseService: typeof PurchaseService;
  /** Re-imported `POSService` instance bound to `prisma`.
   *
   *  Used by the property-tier sale-totals identity test
   *  (`tests/property/sale-totals-identity.property.test.ts`) to drive
   *  `finalizeSale` against a real `$transaction`. The dynamic
   *  re-import shares the same per-test Prisma singleton as
   *  `PurchaseService`, so seed writes done through `prisma` are
   *  visible inside the service's transactions and vice versa. */
  readonly POSService: typeof POSService;
  /** Re-imported `CustomerService` instance bound to `prisma`.
   *
   *  Exposed alongside `PurchaseService` and `POSService` for parity
   *  — Phase 9 task 9.4 (the customer flow integration test) will
   *  exercise `list`, `upsert`, and `detail` through this reference,
   *  and this fixture is the only place that hands services bound to
   *  the per-test Prisma client. */
  readonly CustomerService: typeof CustomerService;
  /** Re-imported `ReportService` instance bound to `prisma`.
   *
   *  Phase 10 tasks 10.1–10.4 expose this alongside `POSService` so
   *  integration tests can finalize a few sales through the real POS
   *  transaction and then assert that `dailySales` /
   *  `monthlySales` / `lowStockSummary` / `topSelling` produce the
   *  expected aggregations against the same per-test database. */
  readonly ReportService: typeof ReportService;
  /** Disconnect the client and delete the underlying file + sidecars. */
  readonly cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * SQLite sidecar suffixes the engine creates alongside the main `.db`
 * file. WAL mode produces `-wal` and `-shm`; the legacy rollback
 * journal produces `-journal`. All three must be removed during
 * cleanup so a flaky test does not leak temp files into the runner's
 * tmpdir.
 */
const SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'] as const;

/**
 * Repository root resolved from this file's location. Vitest's `cwd`
 * already points at the repo root when the integration project runs,
 * but resolving explicitly via `process.cwd()` keeps the call site
 * obvious for the `prisma migrate deploy` / `prisma db seed` spawns.
 */
const repoRoot = process.cwd();

/**
 * Compose the spawned-child environment. Inherit the parent env so
 * `PATH`, `NODE_OPTIONS`, etc. flow through, then override
 * `DATABASE_URL` so Prisma's CLI talks to the test DB instead of
 * `prisma/dev.db`.
 */
function childEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
  };
}

/**
 * Run a Prisma CLI command synchronously, inheriting stdio so failures
 * surface clearly in the Vitest output. Throws on non-zero exit.
 *
 * `shell: true` on Windows mirrors `scripts/build-db-template.ts`: npm
 * exposes CLI tools as `.cmd` shims and `spawnSync` refuses to invoke
 * them without a shell since the CVE-2024-27980 fix. The injection
 * surface is non-existent here — every argument is a hard-coded
 * literal and the only env value (`DATABASE_URL`) is constructed
 * from `randomUUID()` and `os.tmpdir()`, neither of which is user
 * input.
 */
function runPrismaCli(
  args: readonly string[],
  databaseUrl: string,
): void {
  const result = spawnSync('npx', ['prisma', ...args], {
    cwd: repoRoot,
    env: childEnv(databaseUrl),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw new Error(
      `[temp-db] failed to spawn prisma ${args.join(' ')}: ${result.error.message}`,
    );
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    throw new Error(
      `[temp-db] prisma ${args.join(' ')} exited with status ` +
        `${result.status ?? 'null'} (signal=${result.signal ?? 'none'}).`,
    );
  }
}

/**
 * Remove the test DB file and every SQLite sidecar. `rmSync` with
 * `force: true` silences ENOENT, so the function is safe to call even
 * if a particular sidecar was never created (rollback journals only
 * appear on certain transaction patterns; WAL files only after the
 * WAL PRAGMA fires).
 */
function deleteDbFiles(dbPath: string): void {
  rmSync(dbPath, { force: true });
  for (const suffix of SIDECAR_SUFFIXES) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/**
 * Brand the `globalThis` slot used by `src/main/db/prisma.ts` so we
 * can clear it between tests. Mirrors the type defined in that file.
 * Local re-declaration (rather than importing) keeps the helper
 * decoupled from the singleton's module-level constants.
 */
type GlobalWithPrismaCache = typeof globalThis & {
  __coreRetailErpPrisma?: unknown;
};

// ---------------------------------------------------------------------------
// createTempDb
// ---------------------------------------------------------------------------

/**
 * Create a fresh SQLite database, run migrations + seed, and return
 * a `PrismaClient` bound to it along with the freshly-imported
 * `PurchaseService` reference.
 *
 * Step-by-step:
 *
 *   1. Generate a unique path under `os.tmpdir()` and build the
 *      Prisma `file:` URL. Forward slashes are used unconditionally
 *      so the URL is well-formed on both POSIX and Windows.
 *
 *   2. Override `process.env.DATABASE_URL` for the duration of the
 *      test. The previous value is captured so `cleanup()` can
 *      restore it.
 *
 *   3. Spawn `prisma migrate deploy` (non-interactive, applies the
 *      committed migration history) and `prisma db seed` (writes the
 *      Admin/Cashier roles + initial Setting rows via
 *      `prisma/seed.ts`). Both inherit the overridden DATABASE_URL.
 *
 *   4. Reset Vitest's module cache and clear the singleton's
 *      `globalThis` slot so the next dynamic import of
 *      `@main/db/prisma.js` constructs a brand-new `PrismaClient`
 *      against the per-test file. This is the technique referenced
 *      in design.md > "Test infrastructure" — every paginated
 *      service module imports the singleton, so swapping the
 *      singleton swaps every downstream service in one move.
 *
 *   5. Dynamic-import `@main/db/prisma.js` and call `connect()` so
 *      the WAL + foreign-keys PRAGMAs (Req 16.11) are in effect. The
 *      foreign-keys PRAGMA is what makes the FK_VIOLATION assertion
 *      in the atomicity test fire — SQLite defaults FK enforcement
 *      OFF per connection.
 *
 *   6. Dynamic-import `@main/services/purchase.service.js` so the
 *      service module also picks up the fresh singleton.
 *
 *   7. Return `{ prisma, PurchaseService, cleanup }`.
 *
 * `cleanup` is idempotent: subsequent calls are no-ops.
 */
export async function createTempDb(): Promise<TempDbFixture> {
  // Step 1 — unique path + Prisma URL.
  const dbPath = join(tmpdir(), `core-retail-erp-test-${randomUUID()}.db`);
  // Forward slashes everywhere — Prisma's SQLite parser is happiest
  // with `file:C:/path/with/forward/slashes.db` on Windows. POSIX is
  // unaffected since the path already contains forward slashes.
  const databaseUrl = `file:${dbPath.replace(/\\/g, '/')}`;

  // Step 2 — env override. Capture the previous value so cleanup
  // can restore it; otherwise a later test that imports services
  // statically (or a dev `npm run dev` invocation in the same
  // shell) would see the test DB URL.
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;

  // Step 3 — apply migrations + seed via the Prisma CLI. These
  // commands inherit the env override above. `migrate deploy` is the
  // production pathway: non-interactive, applies committed migrations
  // only, fails on inconsistent history. `db seed` runs the script
  // declared in `package.json`'s `prisma.seed` field
  // (`tsx prisma/seed.ts`).
  runPrismaCli(['migrate', 'deploy'], databaseUrl);
  runPrismaCli(['db', 'seed'], databaseUrl);

  // Step 4 — invalidate Vitest's module cache AND the singleton's
  // global slot so the next dynamic import builds a fresh
  // `PrismaClient`. Both steps are required: `vi.resetModules()`
  // clears the JS module registry so a re-import re-evaluates the
  // module, and the `globalThis` delete clears the cache the module
  // checks first when it re-evaluates.
  vi.resetModules();
  delete (globalThis as GlobalWithPrismaCache).__coreRetailErpPrisma;

  // Step 5 — fresh import + PRAGMA application. The dynamic import
  // sees the new `DATABASE_URL` and constructs a fresh client. We
  // apply the load-bearing PRAGMAs directly via `$queryRawUnsafe`
  // rather than calling the singleton's `connect()` helper, because
  // `connect()` runs the PRAGMAs through `$executeRawUnsafe` which
  // rejects statements that return result rows — and SQLite's
  // `journal_mode` PRAGMA echoes the new mode as a result row,
  // causing Prisma to throw "Execute returned results, which is not
  // allowed in SQLite". Production code path is out of scope for
  // this task.
  //
  // For the integration tier the crucial PRAGMA is `foreign_keys=ON`:
  // SQLite defaults FK enforcement OFF per connection, so without it
  // the second test ("rolls back every write when one line
  // references a non-existent product") would never see the
  // `FK_VIOLATION` envelope — the bad productId would be inserted
  // silently. The other PRAGMAs are mirrored from
  // `PRAGMA_STATEMENTS` in `src/main/db/prisma.ts` so behaviour
  // stays close to production.
  const prismaModule = await import('@main/db/prisma.js');
  const prisma = prismaModule.prisma;
  await prisma.$connect();
  // `journal_mode=WAL` is intentionally omitted — it returns a
  // result row that Prisma's `executeRaw` family rejects, and WAL is
  // not required for any assertion in this test.
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys=ON;');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000;');

  // Step 6 — fresh import of the service(s) under test. They reuse
  // the singleton imported above, so seed writes done by the test
  // through `prisma` are visible to the services and vice versa.
  // Both services share the same per-test Prisma client — Prisma's
  // module-level cache plus our `globalThis` slot guarantee a single
  // instance per import graph.
  const purchaseModule = await import('@main/services/purchase.service.js');
  const posModule = await import('@main/services/pos.service.js');
  const customerModule = await import('@main/services/customer.service.js');
  const reportModule = await import('@main/services/report.service.js');

  // Step 7 — cleanup closure. Captures `prisma`, `dbPath`, and the
  // previous DATABASE_URL by reference so the test does not have to
  // pass them back in.
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;

    // Disconnect releases the file handle so the rmSync calls below
    // succeed on Windows (where open handles prevent deletion).
    try {
      await prismaModule.disconnect();
    } catch {
      // Swallow: a failed disconnect is not actionable from the test
      // and we still want to free the file. The dropped file becomes
      // orphan tmp clutter at worst.
    }

    deleteDbFiles(dbPath);

    // Restore env. `delete` if the parent had no DATABASE_URL set;
    // assignment otherwise. Mirrors the Node convention for
    // distinguishing "unset" from "empty".
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }

    // Clear the singleton slot one more time so the NEXT test
    // (or any leftover code in the same process) does not pick up
    // this test's now-disconnected client.
    delete (globalThis as GlobalWithPrismaCache).__coreRetailErpPrisma;
  };

  return {
    prisma,
    PurchaseService: purchaseModule.PurchaseService,
    POSService: posModule.POSService,
    CustomerService: customerModule.CustomerService,
    ReportService: reportModule.ReportService,
    cleanup,
  };
}
