import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the scheduler module (Phase 11, tasks 11.2 + 11.2.1).
 *
 * Drives the schedulers with `vi.useFakeTimers()` so we can assert:
 *
 *   - on app start, if today has no snapshot the scheduler runs one
 *     (Req 10.1),
 *   - the 30-minute interval re-runs the daily-snapshot check
 *     (Req 10.1),
 *   - the 60-minute interval calls `PRAGMA wal_checkpoint(PASSIVE)`
 *     (Req 16.11),
 *   - a node-cron job is registered for the maintenance schedule
 *     (Req 16.10).
 *
 * `BackupService` and `node-cron` are mocked so the assertions cover
 * scheduler behaviour without re-exercising the BackupService unit
 * tests' surface.
 */

// ---------------------------------------------------------------------------
// node-cron mock — captured at hoist time so the scheduler import sees it.
// ---------------------------------------------------------------------------

const cronMock = vi.hoisted(() => {
  interface FakeTask {
    expression: string;
    onTick: () => void;
    stop: () => void;
    running: boolean;
  }
  const tasks: FakeTask[] = [];
  const schedule = vi.fn((expression: string, onTick: () => void) => {
    const task: FakeTask = {
      expression,
      onTick,
      running: true,
      stop: vi.fn(),
    };
    tasks.push(task);
    return task;
  });
  const validate = vi.fn(() => true);
  return {
    schedule,
    validate,
    tasks,
    reset(): void {
      tasks.length = 0;
      schedule.mockClear();
      validate.mockReset();
      validate.mockImplementation(() => true);
    },
  };
});

vi.mock('node-cron', () => ({
  default: {
    schedule: cronMock.schedule,
    validate: cronMock.validate,
  },
  schedule: cronMock.schedule,
  validate: cronMock.validate,
}));

// ---------------------------------------------------------------------------
// BackupService mock — record snapshot + maintenance calls; no real I/O.
// ---------------------------------------------------------------------------

interface OkResult<T> {
  ok: true;
  value: T;
}

const backupMock = vi.hoisted(() => {
  const okLastSnapshot = (at: string | null): OkResult<{ at: string | null }> => ({
    ok: true,
    value: { at },
  });
  const okTakeSnapshot = (): OkResult<{ path: string }> => ({
    ok: true,
    value: { path: '/tmp/fake-snapshot.db' },
  });
  const okWeekly = (): OkResult<{ vacuumMs: number; analyzeMs: number }> => ({
    ok: true,
    value: { vacuumMs: 5, analyzeMs: 3 },
  });
  const okRetention = (): OkResult<{ deletedCount: number }> => ({
    ok: true,
    value: { deletedCount: 0 },
  });

  const lastSnapshotImpl = vi.fn(() => Promise.resolve(okLastSnapshot(null)));
  const takeSnapshotImpl = vi.fn(() => Promise.resolve(okTakeSnapshot()));
  const weeklyMaintenanceImpl = vi.fn(() => Promise.resolve(okWeekly()));
  const enforceRetentionImpl = vi.fn(() => Promise.resolve(okRetention()));

  const formatSnapshotDate = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  return {
    takeSnapshot: takeSnapshotImpl,
    lastSnapshot: lastSnapshotImpl,
    weeklyMaintenance: weeklyMaintenanceImpl,
    enforceRetention: enforceRetentionImpl,
    formatSnapshotDate,
    reset(): void {
      takeSnapshotImpl.mockClear();
      lastSnapshotImpl.mockClear();
      weeklyMaintenanceImpl.mockClear();
      enforceRetentionImpl.mockClear();
      lastSnapshotImpl.mockImplementation(() => Promise.resolve(okLastSnapshot(null)));
      takeSnapshotImpl.mockImplementation(() => Promise.resolve(okTakeSnapshot()));
      weeklyMaintenanceImpl.mockImplementation(() => Promise.resolve(okWeekly()));
    },
  };
});

vi.mock('@main/services/backup.service', () => ({
  BackupService: {
    takeSnapshot: backupMock.takeSnapshot,
    lastSnapshot: backupMock.lastSnapshot,
    weeklyMaintenance: backupMock.weeklyMaintenance,
    enforceRetention: backupMock.enforceRetention,
  },
  formatSnapshotDate: backupMock.formatSnapshotDate,
}));

vi.mock('@main/services/backup.service.js', () => ({
  BackupService: {
    takeSnapshot: backupMock.takeSnapshot,
    lastSnapshot: backupMock.lastSnapshot,
    weeklyMaintenance: backupMock.weeklyMaintenance,
    enforceRetention: backupMock.enforceRetention,
  },
  formatSnapshotDate: backupMock.formatSnapshotDate,
}));

// ---------------------------------------------------------------------------
// prisma mock — only the surfaces the scheduler reads.
// ---------------------------------------------------------------------------

const prismaMock = vi.hoisted(() => {
  const settingFindUnique = vi.fn<
    (args: { where: { key: string }; select?: { value: true } }) => Promise<{ value: string } | null>
  >(() => Promise.resolve(null));
  const executeRawUnsafe = vi.fn<(query: string) => Promise<number>>(() => Promise.resolve(0));
  const journalFindMany = vi.fn<(args: unknown) => Promise<{ timestamp: Date }[]>>(() =>
    Promise.resolve([]),
  );
  return {
    setting: { findUnique: settingFindUnique },
    $executeRawUnsafe: executeRawUnsafe,
    journalEntry: {
      findMany: journalFindMany,
    },
    reset(): void {
      settingFindUnique.mockReset();
      settingFindUnique.mockImplementation(() => Promise.resolve(null));
      executeRawUnsafe.mockReset();
      executeRawUnsafe.mockImplementation(() => Promise.resolve(0));
      journalFindMany.mockReset();
      journalFindMany.mockImplementation(() => Promise.resolve([]));
    },
  };
});

vi.mock('@main/db/prisma', () => ({ prisma: prismaMock }));
vi.mock('@main/db/prisma.js', () => ({ prisma: prismaMock }));

// Imports MUST come after the vi.mock calls.
import {
  DAILY_RECHECK_INTERVAL_MS,
  DEFAULT_MAINTENANCE_CRON,
  WAL_CHECKPOINT_INTERVAL_MS,
  __schedulerTestables,
  getMaintenanceStatus,
  nextCronTick,
  startSchedulers,
  stopSchedulers,
} from '@main/services/scheduler';

// Drain pending microtasks without advancing fake timers. Used after
// `startSchedulers()` to let the kicked-off async work
// (`maybeRunDailySnapshot`, the cron registration promise) complete
// before assertions. Three rounds is enough for the chained
// then/catch/await flow the scheduler uses.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence */
  });
  vi.useFakeTimers();
  cronMock.reset();
  backupMock.reset();
  prismaMock.reset();
  __schedulerTestables.resetForTest();
});

afterEach(() => {
  __schedulerTestables.resetForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startSchedulers — daily snapshot', () => {
  it('takes a snapshot immediately if today has no recorded snapshot', async () => {
    backupMock.lastSnapshot.mockResolvedValueOnce({
      ok: true,
      value: { at: null },
    });

    startSchedulers();
    await flushMicrotasks();

    expect(backupMock.lastSnapshot).toHaveBeenCalledTimes(1);
    expect(backupMock.takeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does NOT take a snapshot when the recorded snapshot is from today', async () => {
    const todayISO = new Date().toISOString();
    backupMock.lastSnapshot.mockResolvedValueOnce({
      ok: true,
      value: { at: todayISO },
    });

    startSchedulers();
    await flushMicrotasks();

    expect(backupMock.takeSnapshot).not.toHaveBeenCalled();
  });

  it('takes a snapshot when the recorded snapshot is from a previous day', async () => {
    const yesterdayISO = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    backupMock.lastSnapshot.mockResolvedValueOnce({
      ok: true,
      value: { at: yesterdayISO },
    });

    startSchedulers();
    await flushMicrotasks();

    expect(backupMock.takeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('rechecks the daily snapshot every 30 minutes', async () => {
    backupMock.lastSnapshot.mockResolvedValue({
      ok: true,
      value: { at: null },
    });
    startSchedulers();
    await flushMicrotasks();
    expect(backupMock.lastSnapshot).toHaveBeenCalledTimes(1);

    // Advance 30 min — the recheck fires.
    await vi.advanceTimersByTimeAsync(DAILY_RECHECK_INTERVAL_MS);
    expect(backupMock.lastSnapshot).toHaveBeenCalledTimes(2);

    // And again at 60 min total.
    await vi.advanceTimersByTimeAsync(DAILY_RECHECK_INTERVAL_MS);
    expect(backupMock.lastSnapshot).toHaveBeenCalledTimes(3);
  });
});

describe('startSchedulers — WAL checkpoint fallback (Req 16.11)', () => {
  it('does not run a checkpoint immediately on start', async () => {
    startSchedulers();
    await flushMicrotasks();
    const checkpointCalls = prismaMock.$executeRawUnsafe.mock.calls.filter((c) =>
      String(c[0]).includes('wal_checkpoint'),
    );
    expect(checkpointCalls).toHaveLength(0);
  });

  it('runs PRAGMA wal_checkpoint(PASSIVE) every 60 minutes', async () => {
    startSchedulers();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(WAL_CHECKPOINT_INTERVAL_MS);
    let calls = prismaMock.$executeRawUnsafe.mock.calls.filter((c) =>
      String(c[0]).includes('wal_checkpoint(PASSIVE)'),
    );
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(WAL_CHECKPOINT_INTERVAL_MS);
    calls = prismaMock.$executeRawUnsafe.mock.calls.filter((c) =>
      String(c[0]).includes('wal_checkpoint(PASSIVE)'),
    );
    expect(calls).toHaveLength(2);
  });

  it('swallows errors thrown by the WAL checkpoint (DB closed during shutdown)', async () => {
    prismaMock.$executeRawUnsafe.mockRejectedValueOnce(new Error('connection closed'));
    startSchedulers();
    await flushMicrotasks();

    await expect(
      vi.advanceTimersByTimeAsync(WAL_CHECKPOINT_INTERVAL_MS),
    ).resolves.not.toThrow();
  });
});

describe('startSchedulers — node-cron weekly maintenance (Req 16.10)', () => {
  it('registers a node-cron task with the default expression when the Setting is missing', async () => {
    startSchedulers();
    await flushMicrotasks();

    expect(cronMock.schedule).toHaveBeenCalledTimes(1);
    expect(cronMock.schedule.mock.calls[0]?.[0]).toBe(DEFAULT_MAINTENANCE_CRON);
  });

  it('reads the cron expression from the Setting "maintenance.cron" when present', async () => {
    prismaMock.setting.findUnique.mockResolvedValueOnce({ value: JSON.stringify('15 4 * * 1') });
    startSchedulers();
    await flushMicrotasks();

    expect(cronMock.schedule).toHaveBeenCalledTimes(1);
    expect(cronMock.schedule.mock.calls[0]?.[0]).toBe('15 4 * * 1');
  });

  it('falls back to the default cron when validate() rejects the Setting value', async () => {
    cronMock.validate.mockImplementation(() => false);
    prismaMock.setting.findUnique.mockResolvedValueOnce({ value: JSON.stringify('not-a-cron') });
    startSchedulers();
    await flushMicrotasks();

    expect(cronMock.schedule.mock.calls[0]?.[0]).toBe(DEFAULT_MAINTENANCE_CRON);
  });

  it('runs BackupService.weeklyMaintenance when the cron tick fires', async () => {
    startSchedulers();
    await flushMicrotasks();
    const task = cronMock.tasks[0];
    expect(task).toBeDefined();

    task!.onTick();
    // The cron callback wraps weeklyMaintenance; flush microtasks.
    await flushMicrotasks();
    await Promise.resolve();
    expect(backupMock.weeklyMaintenance).toHaveBeenCalledTimes(1);
  });
});

describe('startSchedulers idempotency', () => {
  it('is a no-op on repeated calls', async () => {
    startSchedulers();
    startSchedulers();
    startSchedulers();
    await flushMicrotasks();

    expect(backupMock.lastSnapshot).toHaveBeenCalledTimes(1);
    expect(cronMock.schedule).toHaveBeenCalledTimes(1);
    const state = __schedulerTestables.state();
    expect(state.intervals.length).toBe(2); // 30-min + 60-min
    expect(state.cronTasks.length).toBe(1);
    expect(state.started).toBe(true);
  });
});

describe('stopSchedulers', () => {
  it('clears every interval and stops every cron task', async () => {
    startSchedulers();
    await flushMicrotasks();
    const cronTask = cronMock.tasks[0];
    expect(cronTask).toBeDefined();

    stopSchedulers();
    expect(cronTask!.stop).toHaveBeenCalled();
    const stateAfter = __schedulerTestables.state();
    expect(stateAfter.intervals.length).toBe(0);
    expect(stateAfter.cronTasks.length).toBe(0);
    expect(stateAfter.started).toBe(false);

    // No more snapshot calls fire after stop.
    backupMock.lastSnapshot.mockClear();
    await vi.advanceTimersByTimeAsync(DAILY_RECHECK_INTERVAL_MS);
    expect(backupMock.lastSnapshot).not.toHaveBeenCalled();
  });

  it('is idempotent — calling before start does nothing', () => {
    expect(() => {
      stopSchedulers();
    }).not.toThrow();
    expect(() => {
      stopSchedulers();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// nextCronTick
// ---------------------------------------------------------------------------

describe('nextCronTick', () => {
  beforeEach(() => {
    cronMock.validate.mockImplementation(() => true);
  });

  it('computes the next Sunday 03:00 from a Wednesday', () => {
    const wed = new Date(2024, 4, 1, 12, 0); // Wed May 1, 2024 12:00 local
    const next = nextCronTick('0 3 * * 0', wed);
    expect(next).not.toBeNull();
    expect(next?.getDay()).toBe(0); // Sunday
    expect(next?.getHours()).toBe(3);
    expect(next?.getMinutes()).toBe(0);
  });

  it('returns null for an invalid cron expression', () => {
    cronMock.validate.mockImplementation(() => false);
    expect(nextCronTick('not-a-cron', new Date())).toBeNull();
  });

  it('returns a strictly future tick (never the same minute)', () => {
    const now = new Date(2024, 4, 5, 3, 0); // Sun May 5, 2024 03:00 (a tick of the default cron)
    const next = nextCronTick('0 3 * * 0', now);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
  });
});

// ---------------------------------------------------------------------------
// getMaintenanceStatus
// ---------------------------------------------------------------------------

describe('getMaintenanceStatus', () => {
  it('returns the active cron, last run, and next scheduled run', async () => {
    cronMock.validate.mockImplementation(() => true);
    prismaMock.setting.findUnique.mockResolvedValueOnce({ value: JSON.stringify('0 3 * * 0') });
    const lastRunDate = new Date('2024-05-05T03:00:00.000Z');
    prismaMock.journalEntry.findMany.mockResolvedValueOnce([{ timestamp: lastRunDate }]);

    const status = await getMaintenanceStatus({ now: () => new Date(2024, 4, 6, 12, 0) });
    expect(status.cron).toBe('0 3 * * 0');
    expect(status.lastRun).toBe(lastRunDate.toISOString());
    expect(status.nextScheduled).not.toBeNull();
  });

  it('reports null lastRun when no maintenance journal entry exists', async () => {
    prismaMock.setting.findUnique.mockResolvedValueOnce(null);
    prismaMock.journalEntry.findMany.mockResolvedValueOnce([]);

    const status = await getMaintenanceStatus({ now: () => new Date(2024, 4, 1) });
    expect(status.cron).toBe(DEFAULT_MAINTENANCE_CRON);
    expect(status.lastRun).toBeNull();
    expect(status.nextScheduled).not.toBeNull();
  });
});
