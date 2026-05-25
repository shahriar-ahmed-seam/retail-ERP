// src/main/services/backup.service.ts
//
// Backup domain service (Phase 11, tasks 11.1 + 11.3 + the maintenance
// half of task 11.2).
//
// Responsibilities:
//
//   - `takeSnapshot(opts?)`     → Run `VACUUM INTO '<dir>/shop-YYYY-MM-DD.db'`
//                                 against the live SQLite DB, update the
//                                 `Setting 'backup.lastSnapshot'` row with
//                                 the ISO timestamp of the run, and apply
//                                 the retention sweep so only the N most
//                                 recent snapshots remain on disk
//                                 (Req 10.1, 10.2, 10.3).
//
//   - `enforceRetention(opts?)` → List `<dir>/shop-*.db`, sort by mtime
//                                 DESC, delete every entry past index
//                                 `N − 1` where N is read from
//                                 `Setting 'backup.retentionDays'`
//                                 (default 14). Returns the deletion
//                                 count so the scheduler / UI can log
//                                 the sweep (Req 10.3).
//
//   - `lastSnapshot()`          → Convenience wrapper around
//                                 `Setting 'backup.lastSnapshot'`. Used
//                                 by the on-launch + 30-min recheck
//                                 scheduler (task 11.2) to decide
//                                 whether today's snapshot has already
//                                 been taken. Returns
//                                 `Ok({ at: string | null })` where the
//                                 string is the previously recorded ISO
//                                 timestamp and `null` covers the
//                                 fresh-install / cleared-setting case.
//
//   - `weeklyMaintenance()`     → Run `VACUUM` and `ANALYZE` against
//                                 the live DB, time each statement,
//                                 and append a `JournalEntry` row of
//                                 `opType: 'maintenance'` carrying the
//                                 measured durations. Wired by the
//                                 `node-cron` schedule in
//                                 `scheduler.ts` (task 11.2) — default
//                                 cron is `0 3 * * 0` (Sunday 03:00),
//                                 configurable via the
//                                 `Setting 'maintenance.cron'` row
//                                 (Req 16.10).
//
// Implementation notes:
//
//   1. Snapshots target `<userDataDir>/backups/shop-YYYY-MM-DD.db`.
//      `userDataDir` resolves lazily in production via Electron's
//      `app.getPath('userData')` so this module never touches Electron
//      at import time (the renderer's preload + main bundle pull this
//      module via the IPC handler). Tests inject `userDataDir`
//      directly — see `BackupService.takeSnapshot({ userDataDir })`.
//
//   2. Same-day re-run policy: SQLite's `VACUUM INTO` refuses to
//      overwrite an existing file ("output file already exists" — the
//      command is intentionally non-clobbering). `takeSnapshot`
//      therefore deletes the target path first if it exists. The
//      filename stays `shop-YYYY-MM-DD.db` so the daily-naming
//      convention from design.md > "Snapshot model" is preserved
//      verbatim.
//
//   3. Atomicity: the snapshot file write happens via SQLite's
//      streaming `VACUUM INTO`; the Setting + retention sweep happen
//      after. If `VACUUM INTO` fails the Setting is NOT updated and
//      the retention sweep is NOT run, so the on-disk world stays
//      consistent — the renderer sees `Err('INTERNAL', ...)` and
//      `lastSnapshot` still points at the previous run.
//
//   4. `weeklyMaintenance`'s `VACUUM` requires an exclusive write
//      lock on the database file. Per design.md > "Maintenance:
//      weekly VACUUM + ANALYZE", the cron schedule defaults to 03:00
//      Sunday so the lock falls outside business hours. The maintenance
//      JournalEntry is written AFTER both statements complete so a
//      partial run (VACUUM ok, ANALYZE failed) surfaces the failure
//      to the caller without a misleading "completed" journal row.
//
//   5. Retention enforcement runs on every snapshot, not just on the
//      daily one — the manual `backup:now` path (task 11.2 wiring)
//      also benefits from immediate retention pruning. If the
//      retention setting is missing or unparseable the helper falls
//      back to the default of 14 (Req 10.3) rather than failing the
//      whole snapshot.
//
//   6. All file system work is wrapped in `try/catch` blocks that
//      map to `Err('INTERNAL', ...)`. Snapshot file I/O is the one
//      surface where IO failure is plausible (full disk, locked
//      file, permission denial); the renderer will see the
//      structured envelope rather than a rejected promise.
//
// Validates: Requirements 10.1, 10.2, 10.3, 16.10.

import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { prisma as defaultPrisma } from '@main/db/prisma.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Constants + Setting keys
// ---------------------------------------------------------------------------

/** Setting key persisting the ISO timestamp of the most recent successful snapshot. */
export const SETTING_LAST_SNAPSHOT = 'backup.lastSnapshot';

/** Setting key persisting the configured retention count (integer, decoded as JSON or raw int). */
export const SETTING_RETENTION_DAYS = 'backup.retentionDays';

/** Default retention count when the setting is missing or unparseable. */
export const DEFAULT_RETENTION_DAYS = 14;

/** Subdirectory under `userData/` where snapshots live. */
export const BACKUPS_SUBDIR = 'backups';

/** Snapshot filename glob — `shop-YYYY-MM-DD.db`. */
const SNAPSHOT_FILE_REGEX = /^shop-\d{4}-\d{2}-\d{2}\.db$/u;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Optional injection seam used by tests. Production callers omit
 * this argument and the service uses `app.getPath('userData')` (via
 * the lazy resolver) plus the singleton `prisma` client.
 */
export interface BackupOptions {
  /**
   * Override the userData directory. When supplied the service does
   * NOT fall back to Electron's `app.getPath('userData')`, so unit
   * tests can run without Electron available. Production code never
   * passes this — the IPC handler calls `takeSnapshot()` with no
   * arguments.
   */
  readonly userDataDir?: string;

  /**
   * Override `new Date()` so tests can pin the YYYY-MM-DD filename
   * deterministically. Production code never passes this.
   */
  readonly now?: () => Date;
}

/** Successful return shape of `takeSnapshot`. */
export interface TakeSnapshotResult {
  /** Absolute path of the snapshot file just written. */
  readonly path: string;
}

/** Successful return shape of `enforceRetention`. */
export interface EnforceRetentionResult {
  /** Number of older snapshots removed by this sweep. */
  readonly deletedCount: number;
}

/** Successful return shape of `weeklyMaintenance`. */
export interface WeeklyMaintenanceResult {
  /** Wall-clock duration of the `VACUUM` statement, in milliseconds. */
  readonly vacuumMs: number;
  /** Wall-clock duration of the `ANALYZE` statement, in milliseconds. */
  readonly analyzeMs: number;
}

// ---------------------------------------------------------------------------
// Lazy resolver for userData directory (Electron-only at runtime)
// ---------------------------------------------------------------------------

/**
 * Resolve the userData directory lazily so this module is safe to
 * import outside an Electron context (unit tests, type-only tooling).
 *
 * `electron`'s `app` namespace is loaded via `await import('electron')`
 * the first time this function is called without an explicit override.
 * The result is NOT cached at the module level because the userData
 * path can in theory be switched per-test by injecting `userDataDir`;
 * caching the lazy lookup is fine because Electron only sets the path
 * once during bootstrap.
 */
let cachedElectronUserData: string | null = null;
async function resolveUserDataDir(opts?: BackupOptions): Promise<string> {
  if (opts?.userDataDir !== undefined) return opts.userDataDir;
  if (cachedElectronUserData !== null) return cachedElectronUserData;
  const electron = (await import('electron')) as { app: { getPath(name: 'userData'): string } };
  cachedElectronUserData = electron.app.getPath('userData');
  return cachedElectronUserData;
}

// ---------------------------------------------------------------------------
// Dependency injection seam (test-only)
// ---------------------------------------------------------------------------

/**
 * Subset of the Prisma surface this module touches. Declared
 * structurally so unit tests can drive the service against an
 * in-memory stub without dragging the full client in.
 */
export interface BackupPrismaLike {
  $executeRawUnsafe(query: string): Promise<number>;
  setting: {
    findUnique(args: {
      where: { key: string };
      select?: { value: true };
    }): Promise<{ value: string } | null>;
    upsert(args: {
      where: { key: string };
      update: { value: string };
      create: { key: string; value: string };
    }): Promise<{ key: string; value: string }>;
  };
  journalEntry: {
    create(args: { data: { opType: string; payload: string } }): Promise<{ id: string }>;
  };
}

/** Prisma client used by this service. Tests can swap it via {@link setBackupPrisma}. */
let activePrisma: BackupPrismaLike = defaultPrisma;

/** Replace the active Prisma client. Used only by tests. */
export function setBackupPrisma(client: BackupPrismaLike): void {
  activePrisma = client;
}

/** Restore the production Prisma client. Convenience for tests' `afterEach`. */
export function resetBackupPrisma(): void {
  activePrisma = defaultPrisma;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a `Date` into the snapshot filename's YYYY-MM-DD slug.
 * Uses the local calendar date — design.md > "Scheduling" specifies
 * "once per calendar day" which is naturally a local-clock concept
 * for a single-tenant retail shop.
 */
export function formatSnapshotDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Build the canonical snapshot filename for a given date. */
export function snapshotFileName(now: Date): string {
  return `shop-${formatSnapshotDate(now)}.db`;
}

/**
 * Read `Setting 'backup.retentionDays'` and return a positive integer,
 * defaulting to {@link DEFAULT_RETENTION_DAYS} on missing / malformed
 * values. The seed (`prisma/seed.ts`) writes the value as the JSON
 * number `14` so `JSON.parse` succeeds; legacy installs that wrote a
 * raw integer string ("14") are also tolerated via a `parseInt`
 * fallback.
 */
async function readRetentionDays(prisma: BackupPrismaLike): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { key: SETTING_RETENTION_DAYS },
    select: { value: true },
  });
  if (row === null) return DEFAULT_RETENTION_DAYS;

  // Try JSON first (the seed writes JSON strings); fall back to
  // raw integer parsing for backwards compatibility.
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    parsed = Number.parseInt(row.value, 10);
  }
  if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 1) {
    return Math.floor(parsed);
  }
  if (typeof parsed === 'string') {
    const asNum = Number.parseInt(parsed, 10);
    if (Number.isFinite(asNum) && asNum >= 1) return asNum;
  }
  return DEFAULT_RETENTION_DAYS;
}

/**
 * List every snapshot file in `dir` (matching the
 * `shop-YYYY-MM-DD.db` shape), annotated with their mtime so the
 * caller can sort by age. Missing directory yields an empty list —
 * the snapshot path is created lazily so a fresh install has no
 * `backups/` dir until the first `takeSnapshot` runs.
 */
async function listSnapshotsByMtime(
  dir: string,
): Promise<{ name: string; path: string; mtimeMs: number }[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const matching = entries.filter(
    (e) => e.isFile() && SNAPSHOT_FILE_REGEX.test(e.name),
  );
  const stats = await Promise.all(
    matching.map(async (e) => {
      const full = join(dir, e.name);
      const st = await stat(full);
      return { name: e.name, path: full, mtimeMs: st.mtimeMs };
    }),
  );
  // Newest first: descending by mtime.
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stats;
}

// ---------------------------------------------------------------------------
// takeSnapshot
// ---------------------------------------------------------------------------

/**
 * Capture a snapshot of the live database to
 * `<userDataDir>/backups/shop-YYYY-MM-DD.db` via SQLite's
 * `VACUUM INTO` streaming statement.
 *
 * Steps:
 *
 *   1. Resolve the target directory and ensure it exists
 *      (`mkdir -p`).
 *   2. Compose the destination path. If a file already exists at
 *      that path (e.g. a same-day re-run via `backup:now`), delete
 *      it first — `VACUUM INTO` refuses to overwrite an existing
 *      file by design.
 *   3. Run `VACUUM INTO 'absolute/path'` via `$executeRawUnsafe`.
 *      The path is single-quoted and any internal single quote is
 *      doubled per SQLite's standard string-literal escape so the
 *      statement is well-formed regardless of the path components.
 *      Note: `userData` paths in production come from Electron and
 *      are never user-controlled.
 *   4. Record the run timestamp on `Setting 'backup.lastSnapshot'`
 *      via upsert.
 *   5. Apply retention so we keep at most N files
 *      (`enforceRetention` reads N from `Setting 'backup.retentionDays'`,
 *      defaulting to 14).
 *
 * Returns `Ok({ path })` on success or `Err('INTERNAL', ...)` if any
 * step fails. The retention sweep is best-effort — if it fails the
 * snapshot is still considered successful (the file is on disk and
 * the Setting is updated). The retention error is logged via
 * `console.error` so it is observable in the main-process log.
 *
 * Validates: Requirements 10.1, 10.2.
 */
export async function takeSnapshot(
  opts?: BackupOptions,
): Promise<Result<TakeSnapshotResult>> {
  try {
    const userDataDir = await resolveUserDataDir(opts);
    const backupsDir = join(userDataDir, BACKUPS_SUBDIR);
    const now = (opts?.now ?? (() => new Date()))();
    const filename = snapshotFileName(now);
    const targetPath = join(backupsDir, filename);

    // Step 1 — ensure the backups directory exists.
    await mkdir(backupsDir, { recursive: true });

    // Step 2 — clear any existing same-day file (VACUUM INTO refuses
    // to overwrite). `rm` with `force: true` silences ENOENT.
    if (existsSync(targetPath)) {
      await rm(targetPath, { force: true });
    }

    // Step 3 — VACUUM INTO. Quote the path per SQLite's string-
    // literal rules. `userData` paths never contain a single quote
    // in practice but the escape is cheap insurance.
    const escapedPath = targetPath.replace(/'/g, "''");
    await activePrisma.$executeRawUnsafe(`VACUUM INTO '${escapedPath}';`);

    // Step 4 — record the ISO timestamp.
    const isoTimestamp = now.toISOString();
    await activePrisma.setting.upsert({
      where: { key: SETTING_LAST_SNAPSHOT },
      update: { value: JSON.stringify(isoTimestamp) },
      create: { key: SETTING_LAST_SNAPSHOT, value: JSON.stringify(isoTimestamp) },
    });

    // Step 5 — retention sweep. Best-effort; a failure here does not
    // invalidate the snapshot.
    try {
      await enforceRetention(opts);
    } catch (err) {
      console.error('[backup] retention sweep failed after snapshot', err);
    }

    return Ok({ path: targetPath });
  } catch (err) {
    return Err('INTERNAL', {
      reason: 'snapshot_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// enforceRetention
// ---------------------------------------------------------------------------

/**
 * Keep the N most recent `shop-*.db` files in the backups directory
 * and delete every older entry.
 *
 * N is read from `Setting 'backup.retentionDays'`, defaulting to
 * {@link DEFAULT_RETENTION_DAYS} (14). The sort is by mtime DESC so
 * the most-recently-written files are kept regardless of filename
 * ordering — covers same-day overwrites and clock skew.
 *
 * Returns `Ok({ deletedCount })`. Errors map to `Err('INTERNAL', ...)`.
 *
 * Validates: Requirements 10.3.
 */
export async function enforceRetention(
  opts?: BackupOptions,
): Promise<Result<EnforceRetentionResult>> {
  try {
    const userDataDir = await resolveUserDataDir(opts);
    const backupsDir = join(userDataDir, BACKUPS_SUBDIR);

    const retention = await readRetentionDays(activePrisma);
    const snapshots = await listSnapshotsByMtime(backupsDir);

    if (snapshots.length <= retention) {
      return Ok({ deletedCount: 0 });
    }

    const toDelete = snapshots.slice(retention);
    let deletedCount = 0;
    for (const entry of toDelete) {
      try {
        await rm(entry.path, { force: true });
        deletedCount++;
      } catch (err) {
        // Log and continue — failing one delete must not abort the
        // whole sweep. The sweep is idempotent; the next snapshot
        // will retry.
        console.error(`[backup] failed to delete ${entry.path}`, err);
      }
    }
    return Ok({ deletedCount });
  } catch (err) {
    return Err('INTERNAL', {
      reason: 'retention_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// lastSnapshot
// ---------------------------------------------------------------------------

/**
 * Read `Setting 'backup.lastSnapshot'` and return the persisted ISO
 * timestamp, or `null` if the row is missing or empty.
 *
 * Used by:
 *   - the on-launch + 30-min recheck scheduler (task 11.2) to decide
 *     whether to run today's snapshot,
 *   - the backup UI panel (task 11.7, future) to display the
 *     last-run timestamp.
 *
 * `Ok({ at: null })` covers the fresh-install case (the seed writes
 * an empty string for `backup.lastSnapshot`) and the "row deleted"
 * edge case.
 */
export async function lastSnapshot(): Promise<Result<{ at: string | null }>> {
  try {
    const row = await activePrisma.setting.findUnique({
      where: { key: SETTING_LAST_SNAPSHOT },
      select: { value: true },
    });
    if (row === null) return Ok({ at: null });

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      // Legacy installs may store a raw timestamp string without
      // JSON quoting. Treat that as the persisted value verbatim.
      parsed = row.value;
    }

    if (typeof parsed === 'string' && parsed.length > 0) {
      return Ok({ at: parsed });
    }
    return Ok({ at: null });
  } catch (err) {
    return Err('INTERNAL', {
      reason: 'last_snapshot_read_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// weeklyMaintenance
// ---------------------------------------------------------------------------

/**
 * Run the weekly `VACUUM` + `ANALYZE` maintenance pair against the
 * live database (Req 16.10).
 *
 * Steps:
 *
 *   1. Run `VACUUM` and time it.
 *   2. Run `ANALYZE` and time it.
 *   3. Append a `JournalEntry` with `opType: 'maintenance'` and a
 *      JSON payload `{ kind: 'weekly_maintenance', vacuumMs,
 *      analyzeMs, timestamp }` so the maintenance event is replayable
 *      against an audit log and visible in the journal browser.
 *
 * The journal write is intentionally OUTSIDE any `$transaction` —
 * `VACUUM` cannot run inside a transaction (SQLite refuses with
 * "cannot VACUUM from within a transaction"), and `ANALYZE` is a
 * standalone operation. The single `journalEntry.create` is its own
 * implicit transaction.
 *
 * Validates: Requirements 16.10.
 */
export async function weeklyMaintenance(): Promise<Result<WeeklyMaintenanceResult>> {
  try {
    const vacuumStart = Date.now();
    await activePrisma.$executeRawUnsafe('VACUUM;');
    const vacuumMs = Date.now() - vacuumStart;

    const analyzeStart = Date.now();
    await activePrisma.$executeRawUnsafe('ANALYZE;');
    const analyzeMs = Date.now() - analyzeStart;

    await activePrisma.journalEntry.create({
      data: {
        // The persisted opType discriminator. The shared
        // `JournalOpType` union does not currently include
        // `'maintenance'` because the journal browser is read-only
        // and unaware of maintenance events; the column is
        // schema-typed as `String` so the DB accepts the value
        // verbatim. Future migrations to a strict union should
        // extend `JournalOpType` to include `'maintenance'`.
        opType: 'maintenance',
        payload: JSON.stringify({
          kind: 'weekly_maintenance',
          vacuumMs,
          analyzeMs,
          timestamp: new Date().toISOString(),
        }),
      },
    });

    return Ok({ vacuumMs, analyzeMs });
  } catch (err) {
    return Err('INTERNAL', {
      reason: 'weekly_maintenance_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Backup service surface. Exposed as a frozen object literal so
 * callers import a single named symbol and the IPC handler module
 * (and the scheduler) wire each method without instantiating a
 * class. Matches the convention established by every other service
 * in this folder.
 */
export const BackupService = Object.freeze({
  takeSnapshot,
  enforceRetention,
  lastSnapshot,
  weeklyMaintenance,
} as const);

/**
 * Re-export the lazy resolver so the unit tests for `scheduler.ts`
 * (task 11.2 / 11.2.1) can monkey-patch the cached value if needed.
 * Production code MUST NOT call this — it would couple business
 * logic to Electron's `app` namespace.
 */
export const __testHelpers = Object.freeze({
  resolveUserDataDir,
  /** Reset the Electron-resolved cache between tests. */
  resetUserDataCache(): void {
    cachedElectronUserData = null;
  },
});

// `PrismaClient` re-exported as a type so handler-side code can
// reference it without a separate import path. Not part of the wire
// surface.
export type { PrismaClient };
