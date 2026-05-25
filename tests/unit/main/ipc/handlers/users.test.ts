import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the users IPC handler group (Phase 12, task 12.2).
 *
 * Drives `users:assignRole` through `invokeHandlerForTest` so the
 * assertions cover the full middleware chain (auth + RBAC + handler).
 *
 * Admin-only per the static matrix; cashier attempts must be
 * rejected with `Err('FORBIDDEN')` and produce an `rbac.deny`
 * audit row before the handler runs (Req 8.4).
 *
 * Validates: Requirements 8.5, 13.2, 8.4.
 */

// ---------------------------------------------------------------------------
// AuthService mock
// ---------------------------------------------------------------------------

const authMock = vi.hoisted(() => ({
  assignRole: vi.fn(),
}));

vi.mock('@main/services/auth.service', () => ({
  AuthService: authMock,
}));
vi.mock('@main/services/auth.service.js', () => ({
  AuthService: authMock,
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerUsersHandlers } from '@main/ipc/handlers/users';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { UserDTO } from '@shared/ipc-contract';

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

function makeUserDTO(overrides: Partial<UserDTO> = {}): UserDTO {
  return {
    id: overrides.id ?? 'u-target',
    username: overrides.username ?? 'cashier-1',
    roleId: overrides.roleId ?? 'r-admin',
    roleName: overrides.roleName ?? 'Admin',
    createdAt: overrides.createdAt ?? '2026-05-24T12:00:00.000Z',
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
  authMock.assignRole.mockReset();
  registerUsersHandlers();
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

describe('registerUsersHandlers', () => {
  it('registers users:assignRole', () => {
    expect(hasHandler('users:assignRole')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth + RBAC gates
// ---------------------------------------------------------------------------

describe('users:assignRole', () => {
  it('returns UNAUTHENTICATED with no session', async () => {
    const result = await invokeHandlerForTest('users:assignRole', ADMIN_SENDER, {
      userId: 'u-target',
      roleId: 'r-admin',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(authMock.assignRole).not.toHaveBeenCalled();
  });

  it('denies the Cashier role with FORBIDDEN and writes rbac.deny', async () => {
    bindCashier();
    const result = await invokeHandlerForTest('users:assignRole', CASHIER_SENDER, {
      userId: 'u-target',
      roleId: 'r-admin',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
    const deny = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'users:assignRole',
    );
    expect(deny).toBeDefined();
    expect(deny!.userId).toBe('u-cashier');
    expect(authMock.assignRole).not.toHaveBeenCalled();
  });

  it('Admin can call it; the acting userId is forwarded to the service', async () => {
    const dto = makeUserDTO();
    authMock.assignRole.mockResolvedValue(Ok(dto));
    bindAdmin();

    const result = await invokeHandlerForTest('users:assignRole', ADMIN_SENDER, {
      userId: 'u-target',
      roleId: 'r-admin',
    });

    expect(authMock.assignRole).toHaveBeenCalledWith(
      { userId: 'u-target', roleId: 'r-admin' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(dto);
    }
  });

  it('forwards FK_VIOLATION envelopes (unknown user / unknown role) unchanged', async () => {
    authMock.assignRole.mockResolvedValue(
      Err('FK_VIOLATION', { reason: 'not_found', field: 'userId' }),
    );
    bindAdmin();

    const result = await invokeHandlerForTest('users:assignRole', ADMIN_SENDER, {
      userId: 'gone',
      roleId: 'r-admin',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found', field: 'userId' });
    }
  });

  it('forwards VALIDATION envelopes from the service unchanged', async () => {
    authMock.assignRole.mockResolvedValue(Err('VALIDATION', { field: 'roleId' }));
    bindAdmin();

    const result = await invokeHandlerForTest('users:assignRole', ADMIN_SENDER, {
      userId: 'u-target',
      roleId: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'roleId' });
    }
  });
});
