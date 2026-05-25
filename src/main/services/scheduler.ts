// src/main/services/scheduler.ts
//
// Backup + maintenance + WAL-checkpoint scheduler (Phase 11, tasks
// 11.2 + 11.2.1).
//
// Responsibilities:
//
//   1. On-launch daily snapshot. When `startSchedulers()` runs during
//      main-process bootstrap, look up the most recent
//      `Setting 'backup.lastSnapshot'` and, if today does not already
//      have a recorded snapshot, take one immediately
//      (Req 10.1). The check uses the local calendar date so a shop
//      that opens past midnight on the previous calendar day still
//      gets a fresh snapshot for the new day.
//
//   2. 30-minute recheck. Register a `setInterval(30 * 60 * 1000)`
//      that re-runs the same "is today snapshotted?" check
//      (Req 10.1). This handles the laptop-left-running-overnight
//      case: the on-launch check will not fire again for a multi-day
//      uptime, but the interval keeps the daily-snapshot guarantee
//      intact.
//
//   3. 60-minute WAL checkpoint fallback. Register a
//      `setInterval(60 * 60 * 1000)` that runs
//      `PRAGMA wal_checkpoint(PASSIVE)` against the live DB so the
//      WAL file is checkpointed at least once per hour even when
//      `wal_autocheckpoint=1000` (set in task 1.3) hasn't fired
//      because the page-count threshold was never crossed
//      (Req 16.11). The checkpoint is wrapped in `try/catch` so a
//      "DB connection closed" error during shutdown is a no-op
//      rather than an unhandled rejection.
//
//   4. Weekly VACUUM + ANALYZE cron. Register a `node-cron` job for
//      the schedule recorded in `Setting 'maintenance.cron'`
//      (default `0 3 * * 0` — Sunday 03:00). On each tick, call
//      `BackupService.weeklyMaintenance()` which writes a
//      `JournalEntry` of `opType: 'maintenance'` carrying the
//      measured durations (Req 16.10).
//
// All registered timers and cron jobs are tracked in module-level
// arrays so `stopSchedulers()` can clear them on app quit. The
// stop function is idempotent and tolerant of calls before
// `startSchedulers()` has run (e.g. fast app-start failures that
// trigger `before-quit` before bootstrap completes).
//
// The module is deliberately UI-free. Documenting the maintenance
// window UI surface in settings (the read-only display of the
// active cron, last run, and next scheduled run) is the renderer's
// concern — see `getMaintenanceStatus()` below for the data hook
// the future settings panel can consume.
//
// Validates: Requirements 10.1, 10.2, 16.10, 16.11.

import cron, { type ScheduledTask } from 'node-cron';

import { prisma as defaultPrisma } from '@main/db/prisma.js';
import { BackupService, formatSnapshotDate, type BackupOptions } from '@main/services/backup.service.js';

import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 30 minutes in milliseconds — daily-snapshot recheck cadence (Req 10.1). */
export const DAILY_RECHECK_INTERVAL_MS = 30 * 60 * 1000;

/** 60 minutes in milliseconds — WAL checkpoint fallback cadence (Req 16.11). */
export const WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

/** Setting key for the configurable maintenance cron schedule. */
export const SETTING_MAINTENANCE_CRON = 'maintenance.cron';

/** Default maintenance cron — Sunday at 03:00 local time (Req 16.10). */
export const DEFAULT_MAINTENANCE_CRON = '0 3 * * 0';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Wall-clock interval handles; cleared by `stopSchedulers`. */
const intervals: NodeJS.Timeout[] = [];

/** Cron tasks registered via `node-cron`; cleared by `stopSchedulers`. */
const cronTasks: ScheduledTask[] = [];

/** Tracks whether the schedulers have already been started; idempotent. */
let started = false;

// ---------------------------------------------------------------------------
// Status surface
// ---------------------------------------------------------------------------

/**
 * Status snapshot consumed by the settings UI (task 11.7 future) and
 * by the unit tests. Each field corresponds to one of the
 * documentation requirements in design.md > "Maintenance window UI
 * surface":
 *
 *   - `cron`           — the active cron string from the Setting row,
 *                        or the default if unset.
 *   - `lastRun`        — ISO timestamp of the most recent successful
 *                        weekly maintenance run; `null` if no run has
 *                        completed yet.
 *   - `nextScheduled`  — ISO timestamp of the next tick computed from
 *                        the cron string; `null` if the cron expression
 *                        is invalid (the scheduler falls back to the
 *                        default in that case).
 *
 * The status is read-only by design — full edit moves to a future
 * revision per the task description.
 */
export interface MaintenanceStatus {
  readonly cron: string;
  readonly lastRun: string | null;
  readonly nextScheduled: string | null;
}

/**
 * Optional dependency overrides used by tests so they can run
 * without Electron, without the global prisma singleton, and with
 * controlled time progression. Production code calls
 * `startSchedulers()` with no arguments.
 */
export interface SchedulerDeps {
  /** Prisma client used to read the maintenance cron setting and run WAL checkpoints. */
  readonly prisma?: PrismaClient | (Pick<PrismaClient, '$executeRawUnsafe' | 'setting'>);
  /** Override `new Date()` for deterministic on-launch checks. */
  readonly now?: () => Date;
  /** Forward to `BackupService.takeSnapshot` when the recheck triggers. */
  readonly userDataDir?: string;
  /** Override the cron registration callback for testing (skips real schedule). */
  readonly cronSchedule?: (
    expression: string,
    onTick: () => void | Promise<void>,
  ) => ScheduledTask;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the maintenance cron expression from
 * `Setting 'maintenance.cron'`. Falls back to the default
 * `0 3 * * 0` when the row is missing or unparseable. The Setting
 * value is JSON-encoded by `settings:set` (a quoted string in
 * production); legacy installs that wrote the raw expression are
 * tolerated.
 */
async function readMaintenanceCron(
  prisma: Pick<PrismaClient, 'setting'>,
): Promise<string> {
  const row = await prisma.setting.findUnique({
    where: { key: SETTING_MAINTENANCE_CRON },
    select: { value: true },
  });
  if (row === null) return DEFAULT_MAINTENANCE_CRON;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    parsed = row.value;
  }
  if (typeof parsed === 'string' && parsed.trim().length > 0) {
    return parsed.trim();
  }
  return DEFAULT_MAINTENANCE_CRON;
}

/**
 * Best-effort daily-snapshot check.
 *
 * Compares today's local YYYY-MM-DD slug against the slug parsed from
 * `BackupService.lastSnapshot()`. If they differ, run
 * `BackupService.takeSnapshot()`. Errors are swallowed (logged) so a
 * temporary disk/permission issue never crashes the scheduler;
 * subsequent ticks will retry.
 */
async function maybeRunDailySnapshot(deps: SchedulerDeps): Promise<void> {
  try {
    const last = await BackupService.lastSnapshot();
    if (!last.ok) {
      console.error('[scheduler] failed to read last snapshot setting', last.error);
      return;
    }

    const now = (deps.now ?? (() => new Date()))();
    const todaySlug = formatSnapshotDate(now);

    if (last.value.at !== null) {
      // Parse the recorded timestamp into the local-calendar slug.
      // An unparseable timestamp falls through to "take a snapshot".
      const parsed = new Date(last.value.at);
      if (!Number.isNaN(parsed.getTime())) {
        const lastSlug = formatSnapshotDate(parsed);
        if (lastSlug === todaySlug) {
          return; // already snapshotted today
        }
      }
    }

    const snapshotOpts: BackupOptions = {
      now: deps.now ?? (() => new Date()),
      ...(deps.userDataDir !== undefined ? { userDataDir: deps.userDataDir } : {}),
    };
    const result = await BackupService.takeSnapshot(snapshotOpts);
    if (!result.ok) {
      console.error('[scheduler] daily snapshot failed', result.error);
    }
  } catch (err) {
    console.error('[scheduler] unexpected error during daily snapshot check', err);
  }
}

/**
 * Best-effort WAL checkpoint. Wrapped in `try/catch` so a "DB
 * connection closed" error during shutdown is a no-op rather than
 * an unhandled rejection.
 */
async function runWalCheckpoint(
  prisma: Pick<PrismaClient, '$executeRawUnsafe'>,
): Promise<void> {
  try {
    await prisma.$executeRawUnsafe('PRAGMA wal_checkpoint(PASSIVE);');
  } catch (err) {
    // Connection already closed (app quitting) is the most common
    // case here; log and move on.
    console.error('[scheduler] WAL checkpoint failed', err);
  }
}

/**
 * Compute the next scheduled tick of `expression` after `from`, or
 * `null` if `expression` is invalid. node-cron does not expose a
 * direct "next tick" helper, so we implement a minimal cron-expression
 * walker that handles the V1-supported syntax (literal numbers,
 * `*`, comma-separated lists, ranges via `-`, and step values via
 * `/`). This is sufficient for the read-only status surface — the
 * actual cron scheduling is done by `node-cron`'s validated parser.
 */
export function nextCronTick(expression: string, from: Date = new Date()): Date | null {
  if (!cron.validate(expression)) return null;

  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) return null;
  const [minSpec, hourSpec, domSpec, monthSpec, dowSpec] = parts as [string, string, string, string, string];

  const minutes = expandCronField(minSpec, 0, 59);
  const hours = expandCronField(hourSpec, 0, 23);
  const doms = expandCronField(domSpec, 1, 31);
  const months = expandCronField(monthSpec, 1, 12);
  const dows = expandCronField(dowSpec, 0, 6);
  if (!minutes || !hours || !doms || !months || !dows) return null;

  // Walk forward minute-by-minute up to ~366 days. Any cron firing
  // less than once per year is invalid for our use case.
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // strictly after `from`
  const ceiling = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (candidate <= ceiling) {
    if (
      minutes.has(candidate.getMinutes()) &&
      hours.has(candidate.getHours()) &&
      months.has(candidate.getMonth() + 1) &&
      doms.has(candidate.getDate()) &&
      dows.has(candidate.getDay())
    ) {
      return new Date(candidate);
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

function expandCronField(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  const parts = spec.split(',');
  for (const part of parts) {
    const stepIdx = part.indexOf('/');
    const range = stepIdx >= 0 ? part.slice(0, stepIdx) : part;
    const step = stepIdx >= 0 ? Number.parseInt(part.slice(stepIdx + 1), 10) : 1;
    if (!Number.isFinite(step) || step <= 0) return null;

    let lo = min;
    let hi = max;
    if (range !== '*') {
      const dashIdx = range.indexOf('-');
      if (dashIdx >= 0) {
        lo = Number.parseInt(range.slice(0, dashIdx), 10);
        hi = Number.parseInt(range.slice(dashIdx + 1), 10);
      } else {
        const single = Number.parseInt(range, 10);
        if (!Number.isFinite(single)) return null;
        lo = single;
        hi = single;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      return null;
    }
    for (let v = lo; v <= hi; v += step) {
      out.add(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// startSchedulers / stopSchedulers
// ---------------------------------------------------------------------------

/**
 * Register every backup + maintenance + checkpoint timer.
 *
 * Idempotent — calling twice is a no-op. The bootstrap in
 * `src/main/index.ts` runs this once after `bindIpcHandlers(ipcMain)`
 * and the initial `connect()` so the prisma client is open and PRAGMAs
 * are applied before the first WAL checkpoint fires.
 *
 * On-launch behaviour: the daily snapshot check runs immediately
 * (asynchronously). The 30-min recheck and the 60-min WAL checkpoint
 * intervals start counting from `start time + interval`. The cron
 * job's first tick is whenever the cron expression next matches the
 * wall clock.
 */
export function startSchedulers(deps: SchedulerDeps = {}): void {
  if (started) return;
  started = true;

  const prisma = (deps.prisma ?? defaultPrisma) as PrismaClient;

  // 1. Kick off the on-launch daily snapshot check immediately.
  void maybeRunDailySnapshot(deps);

  // 2. 30-min daily-snapshot recheck (Req 10.1).
  intervals.push(
    setInterval(() => {
      void maybeRunDailySnapshot(deps);
    }, DAILY_RECHECK_INTERVAL_MS),
  );

  // 3. 60-min WAL checkpoint fallback (Req 16.11).
  intervals.push(
    setInterval(() => {
      void runWalCheckpoint(prisma);
    }, WAL_CHECKPOINT_INTERVAL_MS),
  );

  // 4. Weekly VACUUM + ANALYZE cron (Req 16.10). The expression is
  //    read once at start time; restarts pick up Setting changes.
  void readMaintenanceCron(prisma)
    .then((expression) => {
      const validatedExpression = cron.validate(expression)
        ? expression
        : DEFAULT_MAINTENANCE_CRON;

      const onTick = async (): Promise<void> => {
        try {
          const result = await BackupService.weeklyMaintenance();
          if (!result.ok) {
            console.error('[scheduler] weekly maintenance failed', result.error);
          }
        } catch (err) {
          console.error('[scheduler] weekly maintenance threw', err);
        }
      };

      // Allow tests to inject their own cron.schedule replacement;
      // production uses `node-cron` directly.
      const schedule =
        deps.cronSchedule ??
        ((expr: string, fn: () => void): ScheduledTask => cron.schedule(expr, fn));
      const task = schedule(validatedExpression, () => {
        void onTick();
      });
      cronTasks.push(task);
    })
    .catch((err) => {
      console.error('[scheduler] failed to register maintenance cron', err);
    });
}

/**
 * Stop every registered timer / cron task. Idempotent. Called from
 * `app.before-quit` so the schedulers do not fire after the prisma
 * client has been disconnected.
 */
export function stopSchedulers(): void {
  for (const handle of intervals) {
    clearInterval(handle);
  }
  intervals.length = 0;

  for (const task of cronTasks) {
    try {
      task.stop();
    } catch (err) {
      console.error('[scheduler] failed to stop cron task', err);
    }
  }
  cronTasks.length = 0;

  started = false;
}

// ---------------------------------------------------------------------------
// Maintenance status (read-only surface)
// ---------------------------------------------------------------------------

/**
 * Return the read-only maintenance status used by the future settings
 * UI panel (the read-only "active cron, last run, next scheduled run"
 * display). The function is exported for direct use by IPC handlers
 * and tests; production wiring is left to a follow-up task.
 */
export async function getMaintenanceStatus(
  deps: { prisma?: Pick<PrismaClient, 'setting' | 'journalEntry'>; now?: () => Date } = {},
): Promise<MaintenanceStatus> {
  const prisma: Pick<PrismaClient, 'setting' | 'journalEntry'> = deps.prisma ?? defaultPrisma;
  const cronExpression = await readMaintenanceCron(prisma);

  // Last run = newest JournalEntry of opType 'maintenance'. Reading
  // the journal directly (rather than a separate Setting row) keeps
  // the source of truth in one place — the journal is what
  // `weeklyMaintenance` writes after a successful run.
  let lastRun: string | null = null;
  try {
    const rows = (await (
      prisma.journalEntry as unknown as {
        findMany(args: {
          where: { opType: string };
          orderBy: { timestamp: 'desc' };
          take: number;
          select: { timestamp: true };
        }): Promise<{ timestamp: Date | string }[]>;
      }
    ).findMany({
      where: { opType: 'maintenance' },
      orderBy: { timestamp: 'desc' },
      take: 1,
      select: { timestamp: true },
    })) as { timestamp: Date | string }[];
    if (rows.length > 0) {
      const ts = rows[0]!.timestamp;
      lastRun = ts instanceof Date ? ts.toISOString() : ts;
    }
  } catch (err) {
    console.error('[scheduler] failed to read last maintenance run', err);
  }

  const now = (deps.now ?? (() => new Date()))();
  const next = nextCronTick(cronExpression, now);
  const nextScheduled = next === null ? null : next.toISOString();

  return { cron: cronExpression, lastRun, nextScheduled };
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Test-only helpers. Production code does not import these.
 */
export const __schedulerTestables = Object.freeze({
  /** Internal state for assertions (intervals/tasks length, started flag). */
  state(): {
    readonly intervals: readonly NodeJS.Timeout[];
    readonly cronTasks: readonly ScheduledTask[];
    readonly started: boolean;
  } {
    return { intervals, cronTasks, started };
  },
  /** Force-reset state without firing the production stop logic. */
  resetForTest(): void {
    for (const handle of intervals) clearInterval(handle);
    intervals.length = 0;
    for (const task of cronTasks) {
      try {
        task.stop();
      } catch {
        /* swallow */
      }
    }
    cronTasks.length = 0;
    started = false;
  },
  maybeRunDailySnapshot,
  runWalCheckpoint,
  readMaintenanceCron,
});
