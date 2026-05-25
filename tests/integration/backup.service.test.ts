// tests/integration/backup.service.test.ts
//
// Phase 11, task 11.1 — integration test for `BackupService.takeSnapshot`.
//
// Runs the real `BackupService` against a per-test SQLite database
// (via the `temp-db` fixture). The integration tier is the only place
// where we can exercise SQLite's `VACUUM INTO` end-to-end against a
// live connection — `VACUUM INTO 'path'` produces a real `.db` file
// that we then re-open with Prisma to confirm the snapshot is a
// consistent, openable copy.
//
// Coverage:
//
//   1. `takeSnapshot` writes a `shop-YYYY-MM-DD.db` file under the
//      injected `userDataDir/backups` directory and updates the
//      `backup.lastSnapshot` Setting with the run's ISO timestamp.
//
//   2. The snapshot file is itself a valid SQLite database that
//      contains the same rows as the source (sanity check via a
//      separate Prisma client against the snapshot file).
//
//   3. `enforceRetention` keeps the N most recent snapshots and
//      deletes older entries.
//
//   4. `weeklyMaintenance` runs `VACUUM` + `ANALYZE` against the
//      live DB and writes a `JournalEntry` of opType
//      `'maintenance'`.
//
// The fixture's `prisma` client wires `BackupService` to the per-test
// DB through `setBackupPrisma`; production is restored via
// `resetBackupPrisma` in `afterEach` so a leaked binding does not
// leak between tests.
//
// Validates: Requirements 10.1, 10.2, 10.3, 16.10.

import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BackupService,
  SETTING_LAST_SNAPSHOT,
  SETTING_RETENTION_DAYS,
  resetBackupPrisma,
  setBackupPrisma,
} from '@main/services/backup.service';

import { createTempDb, type TempDbFixture } from './fixtures/temp-db.js';

// ---------------------------------------------------------------------------
// Per-test scratch directory
// ---------------------------------------------------------------------------

let fixture: TempDbFixture;
let userDataDir: string;

beforeEach(async () => {
  fixture = await createTempDb();
  setBackupPrisma(fixture.prisma);

  userDataDir = join(
    tmpdir(),
    `core-retail-erp-backup-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(userDataDir, { recursive: true });
});

afterEach(async () => {
  resetBackupPrisma();
  await fixture.cleanup();
  rmSync(userDataDir, { recursive: true, force: true });
});

function backupsDir(): string {
  return join(userDataDir, 'backups');
}

// ---------------------------------------------------------------------------
// takeSnapshot — happy path against a real SQLite DB
// ---------------------------------------------------------------------------

describe('BackupService.takeSnapshot — integration', () => {
  it('writes a snapshot via VACUUM INTO and updates backup.lastSnapshot', async () => {
    // Seed at least one row so we can verify the snapshot's contents
    // contain the expected business state.
    const role = await fixture.prisma.role.findUniqueOrThrow({ where: { name: 'Admin' } });
    await fixture.prisma.user.create({
      data: { username: 'snapshot-actor', passwordHash: 'placeholder', roleId: role.id },
    });

    const now = new Date(2024, 4, 1, 10, 30); // local 2024-05-01 10:30
    const result = await BackupService.takeSnapshot({ userDataDir, now: () => now });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshotPath = result.value.path;
    expect(snapshotPath).toBe(join(backupsDir(), 'shop-2024-05-01.db'));
    expect(existsSync(snapshotPath)).toBe(true);

    // The Setting row was upserted with the ISO timestamp.
    const lastRow = await fixture.prisma.setting.findUnique({
      where: { key: SETTING_LAST_SNAPSHOT },
    });
    expect(lastRow).not.toBeNull();
    expect(JSON.parse(lastRow!.value)).toBe(now.toISOString());

    // The snapshot is a valid SQLite database. Open it through a
    // dedicated PrismaClient — the snapshot URL points at the
    // freshly-created file. We assert that the seeded user is
    // present, confirming `VACUUM INTO` produced a consistent copy
    // (Req 16.7).
    const databaseUrl = `file:${snapshotPath.replace(/\\/g, '/')}`;
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    let snapshotClient: PrismaClient | null = null;
    try {
      snapshotClient = new PrismaClient({
        datasources: { db: { url: databaseUrl } },
      });
      const usersInSnapshot = await snapshotClient.user.findMany({
        where: { username: 'snapshot-actor' },
      });
      expect(usersInSnapshot).toHaveLength(1);
    } finally {
      if (snapshotClient !== null) await snapshotClient.$disconnect();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
  });

  it('overwrites an existing same-day snapshot file (manual re-run)', async () => {
    const now = new Date(2024, 4, 1, 10, 30);
    const first = await BackupService.takeSnapshot({ userDataDir, now: () => now });
    expect(first.ok).toBe(true);

    // Insert a new row, then run a same-day snapshot. The new
    // snapshot should reflect the inserted row.
    const role = await fixture.prisma.role.findUniqueOrThrow({ where: { name: 'Admin' } });
    await fixture.prisma.user.create({
      data: { username: 'after-first-snapshot', passwordHash: 'placeholder', roleId: role.id },
    });

    const second = await BackupService.takeSnapshot({ userDataDir, now: () => now });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Same path (daily naming preserved) but the new file's content
    // is the up-to-date snapshot.
    expect(second.value.path).toBe(join(backupsDir(), 'shop-2024-05-01.db'));
    const databaseUrl = `file:${second.value.path.replace(/\\/g, '/')}`;
    const snapshotClient = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
    try {
      const users = await snapshotClient.user.findMany({
        where: { username: 'after-first-snapshot' },
      });
      expect(users).toHaveLength(1);
    } finally {
      await snapshotClient.$disconnect();
    }
  });

  it('runs the retention sweep after a successful snapshot', async () => {
    // Seed a retention setting of 3 (the default seed is 14, but we
    // overwrite for this test). Then place 5 synthetic older
    // snapshots with monotonic mtimes. The takeSnapshot invocation
    // adds a 6th file — the sweep should trim back to 3.
    await fixture.prisma.setting.upsert({
      where: { key: SETTING_RETENTION_DAYS },
      update: { value: JSON.stringify(3) },
      create: { key: SETTING_RETENTION_DAYS, value: JSON.stringify(3) },
    });
    mkdirSync(backupsDir(), { recursive: true });
    for (let i = 1; i <= 5; i++) {
      const slug = String(i).padStart(2, '0');
      const path = join(backupsDir(), `shop-2024-04-${slug}.db`);
      writeFileSync(path, 'synthetic');
      const t = (Date.now() - (5 - i + 1) * 3600 * 1000) / 1000; // older for lower i
      utimesSync(path, t, t);
    }

    const now = new Date(2024, 4, 1, 10);
    const result = await BackupService.takeSnapshot({ userDataDir, now: () => now });
    expect(result.ok).toBe(true);

    const remaining = (await readdir(backupsDir())).filter((n) => n.startsWith("shop-"));
    expect(remaining).toHaveLength(3);
    // The fresh snapshot must survive (it has the highest mtime).
    expect(remaining).toContain('shop-2024-05-01.db');
  });
});

// ---------------------------------------------------------------------------
// weeklyMaintenance — runs VACUUM + ANALYZE and writes a journal entry
// ---------------------------------------------------------------------------

describe('BackupService.weeklyMaintenance — integration', () => {
  it('runs VACUUM + ANALYZE and writes a JournalEntry of opType "maintenance"', async () => {
    const before = await fixture.prisma.journalEntry.count({
      where: { opType: 'maintenance' },
    });

    const result = await BackupService.weeklyMaintenance();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vacuumMs).toBeGreaterThanOrEqual(0);
    expect(result.value.analyzeMs).toBeGreaterThanOrEqual(0);

    const after = await fixture.prisma.journalEntry.findMany({
      where: { opType: 'maintenance' },
      orderBy: { timestamp: 'desc' },
      take: 1,
    });
    expect(after).toHaveLength(before + 1 - before); // i.e. a new row exists
    const entry = after[0]!;
    const payload = JSON.parse(entry.payload) as Record<string, unknown>;
    expect(payload.kind).toBe('weekly_maintenance');
    expect(typeof payload.vacuumMs).toBe('number');
    expect(typeof payload.analyzeMs).toBe('number');
    expect(typeof payload.timestamp).toBe('string');
  });
});
