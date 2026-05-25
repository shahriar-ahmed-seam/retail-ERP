import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the backup IPC handler group (Phase 11, task 11.2
 * wiring of `backup:now` plus the stub for `backup:restore`).
 *
 * Drives each channel through `invokeHandlerForTest` so the assertions
 * cover the full middleware chain (auth + RBAC + handler), not just
 * the handler body.
 *
 * Both backup channels are ADMIN_ONLY per the static matrix —
 * cashiers see `Err('FORBIDDEN')` from the router and an `rbac.deny`
 * audit row is written before the handler runs (Req 8.4).
 *
 * Validates: Requirements 8.2, 8.4, 10.1, 10.2.
 */

// ---------------------------------------------------------------------------
// BackupService mock
// ---------------------------------------------------------------------------

const backupMock = vi.hoisted(() => ({
  takeSnapshot: vi.fn(),
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
  it('registers backup:now and backup:restore', () => {
    expect(hasHandler('backup:now')).toBe(true);
    expect(hasHandler('backup:restore')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerBackupHandlers();
    }).not.toThrow();
    expect(hasHandler('backup:now')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('backup:* require an authenticated session', () => {
  it.each([
    ['backup:now' as const, undefined],
    ['backup:restore' as const, { path: '/some/path' }],
  ])('%s returns UNAUTHENTICATED with no session', async (channel, payload) => {
    const result = await invokeHandlerForTest(channel, ADMIN_SENDER, payload as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(backupMock.takeSnapshot).not.toHaveBeenCalled();
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
// backup:restore — stub
// ---------------------------------------------------------------------------

describe('backup:restore handler (stub)', () => {
  it('Admin call returns Err(INTERNAL, { reason: "NOT_IMPLEMENTED" })', async () => {
    bindAdmin();
    const result = await invokeHandlerForTest('backup:restore', ADMIN_SENDER, {
      path: '/some/path',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.details).toEqual({ reason: 'NOT_IMPLEMENTED' });
    }
  });

  it('Cashier is denied with FORBIDDEN before the stub runs', async () => {
    bindCashier();
    const result = await invokeHandlerForTest('backup:restore', CASHIER_SENDER, {
      path: '/some/path',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'backup:restore' });
    }
    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'backup:restore',
    );
    expect(denyRow).toBeDefined();
  });
});
