import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the backup IPC handler group.
 *
 * Drives each channel through `invokeHandlerForTest` so the assertions
 * cover the full middleware chain (auth + RBAC + handler), not just
 * the handler body.
 *
 * All three backup channels are ADMIN_ONLY per the static matrix —
 * cashiers see `Err('FORBIDDEN')` from the router and an `rbac.deny`
 * audit row is written before the handler runs (Req 8.4).
 *
 * Validates: Requirements 8.2, 8.4, 10.1, 10.2, 10.6, 11.3, 16.8.
 */

// ---------------------------------------------------------------------------
// BackupService mock
// ---------------------------------------------------------------------------

const backupMock = vi.hoisted(() => ({
  takeSnapshot: vi.fn(),
  listSnapshots: vi.fn(),
  restoreSnapshot: vi.fn(),
}));

vi.mock('@main/services/backup.service', () => ({
  BackupService: backupMock,
}));

vi.mock('@main/services/backup.service.js', () => ({
  BackupService: backupMock,
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerBackupHandlers } from '@main/ipc/handlers/backup';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';

// ---------------------------------------------------------------------------
// Recording audit writer
// ---------------------------------------------------------------------------

class RecordingAuditWriter implements AuditWriter {
  public readonly rows: AuditWriteInput[] = [];
  public write(input: AuditWriteInput): Promise<void> {
    this.rows.push(input);
    return Promise.resolve();
  }
}

let recorder: RecordingAuditWriter;
const ADMIN_SENDER = 100;
const CASHIER_SENDER = 200;

function bindAdmin(): void {
  sessionStore.bind(ADMIN_SENDER, {
    userId: 'u-admin',
    role: 'Admin',
    sessionId: 's-admin',
    createdAt: new Date(),
  });
}

function bindCashier(): void {
  sessionStore.bind(CASHIER_SENDER, {
    userId: 'u-cashier',
    role: 'Cashier',
    sessionId: 's-cashier',
    createdAt: new Date(),
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });
  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);
  backupMock.takeSnapshot.mockReset();
  backupMock.listSnapshots.mockReset();
  backupMock.restoreSnapshot.mockReset();
  registerBackupHandlers();
});

afterEach(() => {
  resetAuditWriter();
  clearHandlers();
  sessionStore.clearAll();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

describe('registerBackupHandlers', () => {
  it('registers backup:now, backup:list, and backup:restore', () => {
    expect(hasHandler('backup:now')).toBe(true);
    expect(hasHandler('backup:list')).toBe(true);
    expect(hasHandler('backup:restore')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerBackupHandlers();
    }).not.toThrow();
    expect(hasHandler('backup:now')).toBe(true);
    expect(hasHandler('backup:list')).toBe(true);
    expect(hasHandler('backup:restore')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('backup:* require an authenticated session', () => {
  it.each([
    ['backup:now' as const, undefined],
    ['backup:list' as const, undefined],
    ['backup:restore' as const, { path: '/some/path' }],
  ])('%s returns UNAUTHENTICATED with no session', async (channel, payload) => {
    const result = await invokeHandlerForTest(channel, ADMIN_SENDER, payload as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(backupMock.takeSnapshot).not.toHaveBeenCalled();
    expect(backupMock.listSnapshots).not.toHaveBeenCalled();
    expect(backupMock.restoreSnapshot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// backup:now — Admin path
// ---------------------------------------------------------------------------

describe('backup:now handler', () => {
  it('Admin can call it and receives the snapshot path', async () => {
    backupMock.takeSnapshot.mockResolvedValue(Ok({ path: '/tmp/userData/backups/shop-2024-05-01.db' }));
    bindAdmin();

    const result = await invokeHandlerForTest('backup:now', ADMIN_SENDER, undefined);
    expect(backupMock.takeSnapshot).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toBe('/tmp/userData/backups/shop-2024-05-01.db');
    }
  });

  it('does NOT pass userDataDir to the service (production resolves it lazily)', async () => {
    backupMock.takeSnapshot.mockResolvedValue(Ok({ path: '/x' }));
    bindAdmin();
    await invokeHandlerForTest('backup:now', ADMIN_SENDER, undefined);
    expect(backupMock.takeSnapshot).toHaveBeenCalledWith();
  });

  it('forwards the service Err envelope unchanged', async () => {
    backupMock.takeSnapshot.mockResolvedValue(
      Err('INTERNAL', { reason: 'snapshot_failed', cause: 'disk full' }),
    );
    bindAdmin();

    const result = await invokeHandlerForTest('backup:now', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.details).toMatchObject({ reason: 'snapshot_failed' });
    }
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('backup:now', CASHIER_SENDER, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'backup:now' });
    }
    expect(backupMock.takeSnapshot).not.toHaveBeenCalled();

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'backup:now',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });
});

// ---------------------------------------------------------------------------
// backup:list
// ---------------------------------------------------------------------------

describe('backup:list handler', () => {
  it('Admin can call it and receives the snapshot rows', async () => {
    const rows = [
      {
        filename: 'shop-2024-05-01.db',
        path: '/tmp/userData/backups/shop-2024-05-01.db',
        takenAt: '2024-05-01T10:00:00.000Z',
        sizeBytes: 1024,
      },
    ];
    backupMock.listSnapshots.mockResolvedValue(Ok({ rows }));
    bindAdmin();

    const result = await invokeHandlerForTest('backup:list', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual(rows);
    }
  });

  it('forwards the service Err envelope unchanged', async () => {
    backupMock.listSnapshots.mockResolvedValue(
      Err('INTERNAL', { reason: 'list_snapshots_failed' }),
    );
    bindAdmin();

    const result = await invokeHandlerForTest('backup:list', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
    }
  });

  it('Cashier is denied with FORBIDDEN', async () => {
    bindCashier();
    const result = await invokeHandlerForTest('backup:list', CASHIER_SENDER, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
    expect(backupMock.listSnapshots).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// backup:restore
// ---------------------------------------------------------------------------

describe('backup:restore handler', () => {
  it('Admin call drives the restore + replay flow and returns telemetry', async () => {
    backupMock.restoreSnapshot.mockResolvedValue(
      Ok({ replayed: { batchCount: 2, appliedCount: 17 } }),
    );
    bindAdmin();

    const result = await invokeHandlerForTest('backup:restore', ADMIN_SENDER, {
      path: '/tmp/userData/backups/shop-2024-05-01.db',
    });
    expect(backupMock.restoreSnapshot).toHaveBeenCalledWith({
      path: '/tmp/userData/backups/shop-2024-05-01.db',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.replayed.batchCount).toBe(2);
      expect(result.value.replayed.appliedCount).toBe(17);
    }
  });

  it('forwards the service Err envelope unchanged', async () => {
    backupMock.restoreSnapshot.mockResolvedValue(
      Err('VALIDATION', { field: 'path', reason: 'snapshot_not_found' }),
    );
    bindAdmin();

    const result = await invokeHandlerForTest('backup:restore', ADMIN_SENDER, {
      path: '/missing.db',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  it('Cashier is denied with FORBIDDEN before the handler runs', async () => {
    bindCashier();
    const result = await invokeHandlerForTest('backup:restore', CASHIER_SENDER, {
      path: '/some/path',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'backup:restore' });
    }
    expect(backupMock.restoreSnapshot).not.toHaveBeenCalled();
    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'backup:restore',
    );
    expect(denyRow).toBeDefined();
  });
});
