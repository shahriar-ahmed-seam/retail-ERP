import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `BackupService` (Phase 11, tasks 11.1 + 11.3 +
 * the maintenance half of task 11.2).
 *
 * Drives the service against an in-memory mock of the Prisma surface
 * (`$executeRawUnsafe`, `setting.findUnique`, `setting.upsert`,
 * `journalEntry.create`) and a real-but-temporary `userDataDir` under
 * `os.tmpdir()`. This:
 *
 *   - lets the retention sweep operate on actual files so we can
 *     assert which `shop-*.db` entries survive,
 *   - mocks `$executeRawUnsafe` so we can record the exact `VACUUM
 *     INTO '...'` statement and simulate a successful snapshot by
 *     touching the destination file,
 *   - keeps the test free of any Electron import (the service's
 *     `userDataDir` injection seam is the load-bearing piece).
 *
 * Validates: Requirements 10.1, 10.2, 10.3, 16.10.
 */

import {
  BackupService,
  DEFAULT_RETENTION_DAYS,
  SETTING_LAST_SNAPSHOT,
  SETTING_RETENTION_DAYS,
  enforceRetention,
  formatSnapshotDate,
  lastSnapshot,
  resetBackupPrisma,
  setBackupPrisma,
  snapshotFileName,
  takeSnapshot,
  weeklyMaintenance,
  type BackupPrismaLike,
} from '@main/services/backup.service';

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

interface SettingRow {
  key: string;
  value: string;
}
interface JournalRow {
  id: string;
  opType: string;
  payload: string;
}

interface StubState {
  settings: Map<string, SettingRow>;
  journals: JournalRow[];
  /** Records every `$executeRawUnsafe` call in order. */
  rawCalls: string[];
  /**
   * Optional hook fired when `VACUUM INTO 'path'` is recorded. Tests
   * use this to simulate a successful snapshot by creating the
   * destination file. Defaults to "touch the path".
   */
  onVacuumInto: ((path: string) => void) | null;
  /**
   * If set, throw this error from the next `$executeRawUnsafe` call
   * matching the given prefix. Reset to null on consume.
   */
  rawError: { matches: (sql: string) => boolean; error: Error } | null;
  nextJournalId: number;
}

function createStub(): { stub: BackupPrismaLike; state: StubState } {
  const state: StubState = {
    settings: new Map(),
    journals: [],
    rawCalls: [],
    onVacuumInto: null,
    rawError: null,
    nextJournalId: 0,
  };

  const stub: BackupPrismaLike = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async $executeRawUnsafe(query: string): Promise<number> {
      state.rawCalls.push(query);
      if (state.rawError?.matches(query)) {
        const err = state.rawError.error;
        state.rawError = null;
        throw err;
      }
      // Simulate VACUUM INTO by creating the destination file. The
      // SQL is `VACUUM INTO 'absolute/path';` — extract between the
      // first and last single quote.
      const m = /^VACUUM INTO '(.+)';$/u.exec(query.trim());
      if (m) {
        const path = m[1]?.replace(/''/g, "'") ?? '';
        if (state.onVacuumInto !== null) {
          state.onVacuumInto(path);
        } else {
          writeFileSync(path, 'fake-snapshot-bytes');
        }
      }
      return 0;
    },
    setting: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async findUnique({ where }) {
        const row = state.settings.get(where.key);
        if (row === undefined) return null;
        return { value: row.value };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async upsert({ where, update, create }) {
        const existing = state.settings.get(where.key);
        if (existing !== undefined) {
          existing.value = update.value;
          return existing;
        }
        const fresh: SettingRow = { key: create.key, value: create.value };
        state.settings.set(create.key, fresh);
        return fresh;
      },
    },
    journalEntry: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async create({ data }) {
        const row: JournalRow = {
          id: `j-${state.nextJournalId++}`,
          opType: data.opType,
          payload: data.payload,
        };
        state.journals.push(row);
        return { id: row.id };
      },
    },
  };

  return { stub, state };
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let userDataDir: string;
let stub: BackupPrismaLike;
let state: StubState;

beforeEach(() => {
  userDataDir = join(tmpdir(), `core-retail-erp-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(userDataDir, { recursive: true });

  const created = createStub();
  stub = created.stub;
  state = created.state;
  setBackupPrisma(stub);
});

afterEach(() => {
  resetBackupPrisma();
  rmSync(userDataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapOk<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; details?: unknown } },
): T {
  if (!result.ok) {
    throw new Error(`expected Ok, got Err(${result.error.code})`);
  }
  return result.value;
}

function backupsDir(): string {
  return join(userDataDir, 'backups');
}

/** Create a synthetic `shop-YYYY-MM-DD.db` file with a specified mtime offset (in seconds). */
function createSnapshotFile(name: string, ageSeconds: number): string {
  if (!existsSync(backupsDir())) mkdirSync(backupsDir(), { recursive: true });
  const path = join(backupsDir(), name);
  writeFileSync(path, `synthetic-${name}`);
  const t = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(path, t, t);
  return path;
}

// ---------------------------------------------------------------------------
// formatSnapshotDate / snapshotFileName — pure helpers
// ---------------------------------------------------------------------------

describe('formatSnapshotDate', () => {
  it('formats a Date as YYYY-MM-DD using local components', () => {
    const d = new Date(2024, 4, 1, 10, 30); // May 1, 2024 10:30 local
    expect(formatSnapshotDate(d)).toBe('2024-05-01');
  });

  it('zero-pads month and day', () => {
    const d = new Date(2024, 0, 5, 0, 0);
    expect(formatSnapshotDate(d)).toBe('2024-01-05');
  });
});

describe('snapshotFileName', () => {
  it('produces shop-YYYY-MM-DD.db', () => {
    const d = new Date(2024, 6, 15, 10);
    expect(snapshotFileName(d)).toBe('shop-2024-07-15.db');
  });
});

// ---------------------------------------------------------------------------
// takeSnapshot
// ---------------------------------------------------------------------------

describe('BackupService.takeSnapshot', () => {
  it('runs VACUUM INTO targeting the daily filename and returns Ok({ path })', async () => {
    const now = new Date(2024, 4, 1, 10, 0);
    const result = await takeSnapshot({ userDataDir, now: () => now });
    const value = unwrapOk(result);

    const expectedPath = join(backupsDir(), 'shop-2024-05-01.db');
    expect(value.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const vacuumCall = state.rawCalls.find((q) => q.startsWith('VACUUM INTO'));
    expect(vacuumCall).toBeDefined();
    expect(vacuumCall).toBe(`VACUUM INTO '${expectedPath.replace(/'/g, "''")}';`);
  });

  it('creates the backups directory when missing', async () => {
    rmSync(backupsDir(), { recursive: true, force: true });
    const now = new Date(2024, 4, 1);
    await takeSnapshot({ userDataDir, now: () => now });
    expect(existsSync(backupsDir())).toBe(true);
  });

  it('updates Setting "backup.lastSnapshot" with the run ISO timestamp', async () => {
    const now = new Date('2024-05-01T10:30:00.000Z');
    await takeSnapshot({ userDataDir, now: () => now });

    const stored = state.settings.get(SETTING_LAST_SNAPSHOT);
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!.value)).toBe(now.toISOString());
  });

  it('overwrites an existing same-day snapshot file (manual re-run)', async () => {
    const now = new Date(2024, 4, 1, 10);
    const dayPath = join(backupsDir(), 'shop-2024-05-01.db');
    mkdirSync(backupsDir(), { recursive: true });
    writeFileSync(dayPath, 'old-content');

    await takeSnapshot({ userDataDir, now: () => now });

    expect(existsSync(dayPath)).toBe(true);
    expect(readFileSync(dayPath, 'utf8')).toBe('fake-snapshot-bytes');
  });

  it('returns Err(INTERNAL) when VACUUM INTO fails and does not update the setting', async () => {
    state.rawError = {
      matches: (q) => q.startsWith('VACUUM INTO'),
      error: new Error('disk full'),
    };
    const result = await takeSnapshot({ userDataDir, now: () => new Date(2024, 4, 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      const details = result.error.details as { reason?: string; cause?: string };
      expect(details.reason).toBe('snapshot_failed');
      expect(details.cause).toContain('disk full');
    }
    expect(state.settings.has(SETTING_LAST_SNAPSHOT)).toBe(false);
  });

  it('runs the retention sweep after a successful snapshot', async () => {
    // 16 old files + the new one => 17 in total. Default retention=14
    // → the sweep should leave 14 files.
    state.settings.set(SETTING_RETENTION_DAYS, { key: SETTING_RETENTION_DAYS, value: JSON.stringify(14) });
    for (let i = 1; i <= 16; i++) {
      const slug = String(i).padStart(2, '0');
      createSnapshotFile(`shop-2024-04-${slug}.db`, (16 - i) * 60 * 60); // older = more recent index
    }

    const now = new Date(2024, 4, 1);
    await takeSnapshot({ userDataDir, now: () => now });

    const remaining = (await readdir(backupsDir())).filter((n) => n.startsWith("shop-"));
    expect(remaining).toHaveLength(14);
    // The freshly-created snapshot (highest mtime) must be among them.
    expect(remaining).toContain('shop-2024-05-01.db');
  });
});

// ---------------------------------------------------------------------------
// enforceRetention
// ---------------------------------------------------------------------------

describe('BackupService.enforceRetention', () => {
  it('returns deletedCount: 0 when the directory is empty or missing', async () => {
    const result = unwrapOk(await enforceRetention({ userDataDir }));
    expect(result.deletedCount).toBe(0);
  });

  it('keeps the N most recent files (by mtime) when N is set via the Setting', async () => {
    state.settings.set(SETTING_RETENTION_DAYS, { key: SETTING_RETENTION_DAYS, value: JSON.stringify(3) });
    // 5 files, ages from 5 hours (oldest) to 1 hour (newest).
    createSnapshotFile('shop-2024-04-01.db', 5 * 3600);
    createSnapshotFile('shop-2024-04-02.db', 4 * 3600);
    createSnapshotFile('shop-2024-04-03.db', 3 * 3600);
    createSnapshotFile('shop-2024-04-04.db', 2 * 3600);
    createSnapshotFile('shop-2024-04-05.db', 1 * 3600);

    const result = unwrapOk(await enforceRetention({ userDataDir }));
    expect(result.deletedCount).toBe(2);

    const remaining = (await readdir(backupsDir())).sort();
    expect(remaining).toEqual(['shop-2024-04-03.db', 'shop-2024-04-04.db', 'shop-2024-04-05.db']);
  });

  it('uses default retention of 14 when the Setting is missing', async () => {
    expect(state.settings.has(SETTING_RETENTION_DAYS)).toBe(false);
    for (let i = 0; i < 20; i++) {
      const slug = String(i + 1).padStart(2, '0');
      createSnapshotFile(`shop-2024-04-${slug}.db`, (20 - i) * 60);
    }
    const result = unwrapOk(await enforceRetention({ userDataDir }));
    expect(result.deletedCount).toBe(20 - DEFAULT_RETENTION_DAYS);
    const remaining = (await readdir(backupsDir())).filter((n) => n.startsWith("shop-"));
    expect(remaining).toHaveLength(DEFAULT_RETENTION_DAYS);
  });

  it('falls back to default retention when the Setting value is unparseable', async () => {
    state.settings.set(SETTING_RETENTION_DAYS, { key: SETTING_RETENTION_DAYS, value: 'not-a-number' });
    for (let i = 0; i < 16; i++) {
      const slug = String(i + 1).padStart(2, '0');
      createSnapshotFile(`shop-2024-04-${slug}.db`, (16 - i) * 60);
    }
    const result = unwrapOk(await enforceRetention({ userDataDir }));
    expect(result.deletedCount).toBe(16 - DEFAULT_RETENTION_DAYS);
  });

  it('ignores files that do not match the shop-YYYY-MM-DD.db pattern', async () => {
    state.settings.set(SETTING_RETENTION_DAYS, { key: SETTING_RETENTION_DAYS, value: JSON.stringify(2) });
    createSnapshotFile('shop-2024-04-01.db', 3000);
    createSnapshotFile('shop-2024-04-02.db', 2000);
    createSnapshotFile('shop-2024-04-03.db', 1000);
    // Non-matching files: should NOT be considered or deleted.
    mkdirSync(backupsDir(), { recursive: true });
    writeFileSync(join(backupsDir(), 'README.txt'), 'ignored');
    writeFileSync(join(backupsDir(), 'shop-bad-name.db'), 'ignored');

    const result = unwrapOk(await enforceRetention({ userDataDir }));
    expect(result.deletedCount).toBe(1); // only the oldest snapshot

    const remaining = await readdir(backupsDir());
    expect(remaining).toContain('README.txt');
    expect(remaining).toContain('shop-bad-name.db');
  });

  it('parses retention stored as a raw integer string (legacy format)', async () => {
    state.settings.set(SETTING_RETENTION_DAYS, { key: SETTING_RETENTION_DAYS, value: '3' });
    for (let i = 0; i < 5; i++) {
      const slug = String(i + 1).padStart(2, '0');
      createSnapshotFile(`shop-2024-04-${slug}.db`, (5 - i) * 60);
    }
    const result = unwrapOk(await enforceRetention({ userDataDir }));
    expect(result.deletedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// lastSnapshot
// ---------------------------------------------------------------------------

describe('BackupService.lastSnapshot', () => {
  it('returns Ok({ at: null }) when the setting is missing', async () => {
    const result = unwrapOk(await lastSnapshot());
    expect(result.at).toBeNull();
  });

  it('returns the parsed ISO timestamp when set', async () => {
    state.settings.set(SETTING_LAST_SNAPSHOT, {
      key: SETTING_LAST_SNAPSHOT,
      value: JSON.stringify('2024-05-01T10:30:00.000Z'),
    });
    const result = unwrapOk(await lastSnapshot());
    expect(result.at).toBe('2024-05-01T10:30:00.000Z');
  });

  it('returns Ok({ at: null }) when the JSON value is an empty string', async () => {
    state.settings.set(SETTING_LAST_SNAPSHOT, {
      key: SETTING_LAST_SNAPSHOT,
      value: JSON.stringify(''),
    });
    const result = unwrapOk(await lastSnapshot());
    expect(result.at).toBeNull();
  });

  it('falls back to the raw string for legacy unquoted values', async () => {
    state.settings.set(SETTING_LAST_SNAPSHOT, {
      key: SETTING_LAST_SNAPSHOT,
      value: '2024-05-01T10:30:00.000Z',
    });
    const result = unwrapOk(await lastSnapshot());
    expect(result.at).toBe('2024-05-01T10:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// weeklyMaintenance
// ---------------------------------------------------------------------------

describe('BackupService.weeklyMaintenance', () => {
  it('runs VACUUM then ANALYZE and writes a maintenance journal entry', async () => {
    const result = unwrapOk(await weeklyMaintenance());

    expect(typeof result.vacuumMs).toBe('number');
    expect(result.vacuumMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.analyzeMs).toBe('number');
    expect(result.analyzeMs).toBeGreaterThanOrEqual(0);

    expect(state.rawCalls).toContain('VACUUM;');
    expect(state.rawCalls).toContain('ANALYZE;');
    const vacuumIdx = state.rawCalls.indexOf('VACUUM;');
    const analyzeIdx = state.rawCalls.indexOf('ANALYZE;');
    expect(vacuumIdx).toBeLessThan(analyzeIdx);

    expect(state.journals).toHaveLength(1);
    const journal = state.journals[0]!;
    expect(journal.opType).toBe('maintenance');
    const payload = JSON.parse(journal.payload) as Record<string, unknown>;
    expect(payload.kind).toBe('weekly_maintenance');
    expect(payload.vacuumMs).toBe(result.vacuumMs);
    expect(payload.analyzeMs).toBe(result.analyzeMs);
    expect(typeof payload.timestamp).toBe('string');
  });

  it('returns Err(INTERNAL) when VACUUM fails and writes no journal entry', async () => {
    state.rawError = {
      matches: (q) => q.startsWith('VACUUM;'),
      error: new Error('locked'),
    };
    const result = await weeklyMaintenance();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      const details = result.error.details as { reason?: string };
      expect(details.reason).toBe('weekly_maintenance_failed');
    }
    expect(state.journals).toHaveLength(0);
  });

  it('returns Err(INTERNAL) when ANALYZE fails after VACUUM succeeded', async () => {
    state.rawError = {
      matches: (q) => q.startsWith('ANALYZE;'),
      error: new Error('busy'),
    };
    const result = await weeklyMaintenance();
    expect(result.ok).toBe(false);
    expect(state.journals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Frozen surface
// ---------------------------------------------------------------------------

describe('BackupService surface', () => {
  it('is frozen and exposes the four documented methods', () => {
    expect(Object.isFrozen(BackupService)).toBe(true);
    expect(typeof BackupService.takeSnapshot).toBe('function');
    expect(typeof BackupService.enforceRetention).toBe('function');
    expect(typeof BackupService.lastSnapshot).toBe('function');
    expect(typeof BackupService.weeklyMaintenance).toBe('function');
  });
});

// Silence the router's defensive logs in tests.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence */
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
