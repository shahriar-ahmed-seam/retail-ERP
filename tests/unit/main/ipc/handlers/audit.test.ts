import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the audit IPC handler group (Phase 12, task 12.1).
 *
 * Drives both audit channels through `invokeHandlerForTest` so the
 * assertions cover the full middleware chain (auth + RBAC + handler).
 *
 * Both `audit:list` and `audit:count` are Admin-only per the static
 * matrix — cashier attempts must be rejected with `Err('FORBIDDEN')`
 * and produce an `rbac.deny` audit row before the handler runs
 * (Req 8.4).
 *
 * Validates: Requirements 13, 8.2, 8.4, 16.1, 16.2, 16.3, 16.5.
 */

// ---------------------------------------------------------------------------
// AuditService mock
// ---------------------------------------------------------------------------

const auditMock = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@main/services/audit.service', () => ({
  AuditService: auditMock,
}));
vi.mock('@main/services/audit.service.js', () => ({
  AuditService: auditMock,
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerAuditHandlers } from '@main/ipc/handlers/audit';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { AuditLogDTO } from '@shared/dto/index';

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

function makeAuditDTO(overrides: Partial<AuditLogDTO> = {}): AuditLogDTO {
  return {
    id: overrides.id ?? 'a-1',
    actionType: overrides.actionType ?? 'price.change',
    entityType: overrides.entityType ?? 'product',
    entityId: overrides.entityId ?? 'p-1',
    previous: overrides.previous ?? null,
    next: overrides.next ?? null,
    userId: overrides.userId ?? 'u-admin',
    userName: overrides.userName ?? 'owner',
    timestamp: overrides.timestamp ?? '2026-05-24T12:00:00.000Z',
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence */
  });
  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);
  auditMock.list.mockReset();
  auditMock.count.mockReset();
  registerAuditHandlers();
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

describe('registerAuditHandlers', () => {
  it('registers audit:list and audit:count', () => {
    expect(hasHandler('audit:list')).toBe(true);
    expect(hasHandler('audit:count')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('audit:* require an authenticated session', () => {
  it.each([
    ['audit:list' as const, {}],
    ['audit:count' as const, {}],
  ])('%s returns UNAUTHENTICATED with no session', async (channel, payload) => {
    const result = await invokeHandlerForTest(channel, ADMIN_SENDER, payload as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(auditMock.list).not.toHaveBeenCalled();
    expect(auditMock.count).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RBAC denial path
// ---------------------------------------------------------------------------

describe('audit:* deny the Cashier role and emit an rbac.deny audit row', () => {
  it.each([
    ['audit:list' as const, {}],
    ['audit:count' as const, {}],
  ])('%s returns FORBIDDEN for Cashier and writes an rbac.deny row', async (channel, payload) => {
    bindCashier();
    const result = await invokeHandlerForTest(channel, CASHIER_SENDER, payload as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
    const denyRows = recorder.rows.filter(
      (r) => r.actionType === 'rbac.deny' && r.entityId === channel,
    );
    expect(denyRows).toHaveLength(1);
    expect(denyRows[0]!.userId).toBe('u-cashier');
    // Service was not invoked.
    expect(auditMock.list).not.toHaveBeenCalled();
    expect(auditMock.count).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// audit:list
// ---------------------------------------------------------------------------

describe('audit:list handler', () => {
  it('Admin can call it and receives the list response envelope', async () => {
    const rows = [makeAuditDTO({ id: 'a-1' }), makeAuditDTO({ id: 'a-2' })];
    auditMock.list.mockResolvedValue(Ok({ rows, nextCursor: null }));
    bindAdmin();

    const result = await invokeHandlerForTest('audit:list', ADMIN_SENDER, { pageSize: 50 });
    expect(auditMock.list).toHaveBeenCalledWith({ pageSize: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual(rows);
      expect(result.value.nextCursor).toBeNull();
    }
  });

  it('forwards the request envelope (filter, sort, cursor, pageSize, withCount) untouched', async () => {
    auditMock.list.mockResolvedValue(Ok({ rows: [], nextCursor: null }));
    bindAdmin();

    const req = {
      filter: {
        actionType: 'role.change' as const,
        userId: 'u-target',
        dateFrom: '2026-05-24T00:00:00.000Z',
        dateTo: '2026-05-24T23:59:59.999Z',
      },
      sort: { key: 'timestamp' as const, dir: 'desc' as const },
      cursor: 'opaque-token',
      pageSize: 100,
      withCount: true,
    };
    await invokeHandlerForTest('audit:list', ADMIN_SENDER, req);
    expect(auditMock.list).toHaveBeenCalledWith(req);
  });

  it('forwards VALIDATION envelopes from the service unchanged', async () => {
    auditMock.list.mockResolvedValue(Err('VALIDATION', { field: 'cursor' }));
    bindAdmin();

    const result = await invokeHandlerForTest('audit:list', ADMIN_SENDER, {
      cursor: 'broken',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'cursor' });
    }
  });
});

// ---------------------------------------------------------------------------
// audit:count
// ---------------------------------------------------------------------------

describe('audit:count handler', () => {
  it('Admin receives the totalCount envelope', async () => {
    auditMock.count.mockResolvedValue(Ok({ totalCount: 1234 }));
    bindAdmin();

    const result = await invokeHandlerForTest('audit:count', ADMIN_SENDER, {});
    expect(auditMock.count).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ totalCount: 1234 });
    }
  });

  it('forwards the filter shape to the service', async () => {
    auditMock.count.mockResolvedValue(Ok({ totalCount: 0 }));
    bindAdmin();
    const req = { filter: { actionType: 'role.change' as const } };
    await invokeHandlerForTest('audit:count', ADMIN_SENDER, req);
    expect(auditMock.count).toHaveBeenCalledWith(req);
  });
});
