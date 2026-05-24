import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the auth IPC handler group (Phase 3, task 3.2).
 *
 * Drives each channel through the real `invokeHandlerForTest` seam — the
 * same code path Electron's `ipcMain.handle` binding uses in production —
 * so the assertions cover the full middleware chain (auth + RBAC + audit
 * + handler), not just the handler bodies.
 *
 * The `@main/services/auth.service` module is mocked so we can drive the
 * service return values deterministically without touching SQLite.
 *
 * Validates: Requirements 1.1, 1.2, 1.4, 1.6.
 */

// ---------------------------------------------------------------------------
// AuthService mock (vi.hoisted so factories can reach the spies)
// ---------------------------------------------------------------------------

const authMock = vi.hoisted(() => {
  return {
    login: vi.fn(),
    logout: vi.fn(),
    createInitialAdmin: vi.fn(),
    hasAnyAdmin: vi.fn(),
  };
});

vi.mock('@main/services/auth.service', () => ({
  AuthService: authMock,
  BCRYPT_COST_FACTOR: 12,
}));

// `@main/services/auth.service.js` is the .js-suffixed import path that
// the production handler uses (NodeNext resolution). Vitest treats the
// two as separate module ids unless we mock both.
vi.mock('@main/services/auth.service.js', () => ({
  AuthService: authMock,
  BCRYPT_COST_FACTOR: 12,
}));

// Imports MUST come after `vi.mock` so the handlers see the mocked service.
import { sessionStore } from '@main/auth/session-store';
import { registerAuthHandlers } from '@main/ipc/handlers/auth';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { SessionDTO } from '@shared/ipc-contract';

// ---------------------------------------------------------------------------
// In-memory audit recorder so RBAC denial / declarative-audit attempts do
// not need a Prisma round trip. The auth channels are public and emit no
// audit rows themselves; the recorder mainly proves the *absence* of
// rbac.deny entries on the happy paths.
// ---------------------------------------------------------------------------

class RecordingAuditWriter implements AuditWriter {
  public readonly rows: AuditWriteInput[] = [];
  public write(input: AuditWriteInput): Promise<void> {
    this.rows.push(input);
    return Promise.resolve();
  }
}

let recorder: RecordingAuditWriter;

const SENDER = 12345;

function makeSessionDTO(overrides: Partial<SessionDTO> = {}): SessionDTO {
  return {
    sessionId: overrides.sessionId ?? 'sess-abc',
    userId: overrides.userId ?? 'u-1',
    username: overrides.username ?? 'owner',
    role: overrides.role ?? 'Admin',
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  authMock.login.mockReset();
  authMock.logout.mockReset();
  authMock.createInitialAdmin.mockReset();
  authMock.hasAnyAdmin.mockReset();

  registerAuthHandlers();
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

describe('registerAuthHandlers', () => {
  it('registers auth:login, auth:logout, and setup:createInitialAdmin', () => {
    expect(hasHandler('auth:login')).toBe(true);
    expect(hasHandler('auth:logout')).toBe(true);
    expect(hasHandler('setup:createInitialAdmin')).toBe(true);
    expect(hasHandler('setup:isRequired')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerAuthHandlers();
    }).not.toThrow();
    expect(hasHandler('auth:login')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// auth:login
// ---------------------------------------------------------------------------

describe('auth:login handler', () => {
  it('calls AuthService.login with the request credentials', async () => {
    authMock.login.mockResolvedValue(Ok(makeSessionDTO()));
    await invokeHandlerForTest('auth:login', SENDER, {
      username: 'owner',
      password: 'super-secret-1',
    });
    expect(authMock.login).toHaveBeenCalledTimes(1);
    expect(authMock.login).toHaveBeenCalledWith('owner', 'super-secret-1');
  });

  it('binds the session to the senderId on success and returns the SessionDTO', async () => {
    const dto = makeSessionDTO({ sessionId: 's-login', userId: 'u-7', role: 'Cashier' });
    authMock.login.mockResolvedValue(Ok(dto));

    const result = await invokeHandlerForTest('auth:login', SENDER, {
      username: 'cashier-1',
      password: 'cashier-pw-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(dto);
    }

    const bound = sessionStore.get(SENDER);
    expect(bound).toBeDefined();
    expect(bound?.sessionId).toBe('s-login');
    expect(bound?.userId).toBe('u-7');
    expect(bound?.role).toBe('Cashier');
    expect(bound?.createdAt).toBeInstanceOf(Date);
  });

  it('does NOT bind a session when AuthService.login returns Err', async () => {
    authMock.login.mockResolvedValue(Err('UNAUTHENTICATED'));

    const result = await invokeHandlerForTest('auth:login', SENDER, {
      username: 'owner',
      password: 'wrong',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(sessionStore.get(SENDER)).toBeUndefined();
  });

  it('is reachable without a pre-existing session (requiresAuth: false)', async () => {
    authMock.login.mockResolvedValue(Ok(makeSessionDTO()));
    // No `sessionStore.bind` performed — the channel must still run and
    // return Ok. If `requiresAuth` were the default `true` we would see
    // `Err('UNAUTHENTICATED')` here.
    const result = await invokeHandlerForTest('auth:login', SENDER, {
      username: 'owner',
      password: 'super-secret-1',
    });
    expect(result.ok).toBe(true);
    // Public channel — no rbac.deny rows should leak through.
    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
  });

  it('rebinds the session for the same senderId on a subsequent successful login', async () => {
    authMock.login
      .mockResolvedValueOnce(Ok(makeSessionDTO({ sessionId: 's-1', userId: 'u-1' })))
      .mockResolvedValueOnce(Ok(makeSessionDTO({ sessionId: 's-2', userId: 'u-2' })));

    await invokeHandlerForTest('auth:login', SENDER, { username: 'a', password: 'pw-1' });
    expect(sessionStore.get(SENDER)?.sessionId).toBe('s-1');

    await invokeHandlerForTest('auth:login', SENDER, { username: 'b', password: 'pw-2' });
    expect(sessionStore.get(SENDER)?.sessionId).toBe('s-2');
    expect(sessionStore.get(SENDER)?.userId).toBe('u-2');
  });
});

// ---------------------------------------------------------------------------
// auth:logout
// ---------------------------------------------------------------------------

describe('auth:logout handler', () => {
  it('clears the session bound to the senderId via AuthService.logout', async () => {
    authMock.logout.mockImplementation((id: number) => {
      sessionStore.clear(id);
      return Promise.resolve(Ok(undefined));
    });

    sessionStore.bind(SENDER, {
      userId: 'u-1',
      role: 'Admin',
      sessionId: 's-1',
      createdAt: new Date(),
    });
    expect(sessionStore.get(SENDER)).toBeDefined();

    const result = await invokeHandlerForTest('auth:logout', SENDER, undefined as never);

    expect(result.ok).toBe(true);
    expect(authMock.logout).toHaveBeenCalledWith(SENDER);
    expect(sessionStore.get(SENDER)).toBeUndefined();
  });

  it('is reachable without a pre-existing session (requiresAuth: false)', async () => {
    authMock.logout.mockResolvedValue(Ok(undefined));

    const result = await invokeHandlerForTest('auth:logout', SENDER, undefined as never);
    expect(result.ok).toBe(true);
    expect(authMock.logout).toHaveBeenCalledWith(SENDER);
  });

  it('does not affect bindings on other senderIds', async () => {
    authMock.logout.mockImplementation((id: number) => {
      sessionStore.clear(id);
      return Promise.resolve(Ok(undefined));
    });

    sessionStore.bind(1, {
      userId: 'u-1',
      role: 'Admin',
      sessionId: 's-1',
      createdAt: new Date(),
    });
    sessionStore.bind(2, {
      userId: 'u-2',
      role: 'Cashier',
      sessionId: 's-2',
      createdAt: new Date(),
    });

    await invokeHandlerForTest('auth:logout', 1, undefined as never);

    expect(sessionStore.get(1)).toBeUndefined();
    expect(sessionStore.get(2)?.userId).toBe('u-2');
  });
});

// ---------------------------------------------------------------------------
// setup:createInitialAdmin
// ---------------------------------------------------------------------------

describe('setup:createInitialAdmin handler', () => {
  it('binds the new admin session and returns the SessionDTO on Ok', async () => {
    const sessionDTO = makeSessionDTO({
      sessionId: 's-setup',
      userId: 'u-admin',
      username: 'admin',
      role: 'Admin',
    });
    authMock.createInitialAdmin.mockResolvedValue(
      Ok({
        user: {
          id: 'u-admin',
          username: 'admin',
          roleId: 'r-admin',
          roleName: 'Admin' as const,
          createdAt: '2026-05-24T12:00:00.000Z',
        },
        sessionDTO,
      }),
    );

    const result = await invokeHandlerForTest('setup:createInitialAdmin', SENDER, {
      username: 'admin',
      password: 'super-secret-1',
    });

    expect(authMock.createInitialAdmin).toHaveBeenCalledWith('admin', 'super-secret-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Wire response is the SessionDTO only (per the IPC contract);
      // the service's richer { user, sessionDTO } is intentionally not
      // surfaced.
      expect(result.value).toEqual(sessionDTO);
      expect((result.value as Record<string, unknown>).user).toBeUndefined();
    }

    const bound = sessionStore.get(SENDER);
    expect(bound).toBeDefined();
    expect(bound?.sessionId).toBe('s-setup');
    expect(bound?.userId).toBe('u-admin');
    expect(bound?.role).toBe('Admin');
    expect(bound?.createdAt).toBeInstanceOf(Date);
  });

  it('does NOT bind a session when AuthService.createInitialAdmin returns Err', async () => {
    authMock.createInitialAdmin.mockResolvedValue(
      Err('FORBIDDEN', { reason: 'admin_already_exists' }),
    );

    const result = await invokeHandlerForTest('setup:createInitialAdmin', SENDER, {
      username: 'admin',
      password: 'super-secret-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ reason: 'admin_already_exists' });
    }
    expect(sessionStore.get(SENDER)).toBeUndefined();
  });

  it('forwards VALIDATION envelopes from the service unchanged', async () => {
    authMock.createInitialAdmin.mockResolvedValue(Err('VALIDATION', { field: 'password' }));

    const result = await invokeHandlerForTest('setup:createInitialAdmin', SENDER, {
      username: 'admin',
      password: 'short',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'password' });
    }
    expect(sessionStore.get(SENDER)).toBeUndefined();
  });

  it('is reachable without a pre-existing session (requiresAuth: false)', async () => {
    authMock.createInitialAdmin.mockResolvedValue(
      Ok({
        user: {
          id: 'u-admin',
          username: 'admin',
          roleId: 'r-admin',
          roleName: 'Admin' as const,
          createdAt: '2026-05-24T12:00:00.000Z',
        },
        sessionDTO: makeSessionDTO(),
      }),
    );

    const result = await invokeHandlerForTest('setup:createInitialAdmin', SENDER, {
      username: 'admin',
      password: 'super-secret-1',
    });
    expect(result.ok).toBe(true);
    // Public channel — no rbac.deny rows should leak through.
    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setup:isRequired
// ---------------------------------------------------------------------------

describe('setup:isRequired handler', () => {
  it('returns { required: true } when no admin exists', async () => {
    authMock.hasAnyAdmin.mockResolvedValue(false);

    const result = await invokeHandlerForTest('setup:isRequired', SENDER, undefined as never);

    expect(authMock.hasAnyAdmin).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ required: true });
    }
  });

  it('returns { required: false } when an admin already exists', async () => {
    authMock.hasAnyAdmin.mockResolvedValue(true);

    const result = await invokeHandlerForTest('setup:isRequired', SENDER, undefined as never);

    expect(authMock.hasAnyAdmin).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ required: false });
    }
  });

  it('is reachable without a pre-existing session (requiresAuth: false)', async () => {
    authMock.hasAnyAdmin.mockResolvedValue(false);

    // No `sessionStore.bind` performed — the channel must still run.
    const result = await invokeHandlerForTest('setup:isRequired', SENDER, undefined as never);

    expect(result.ok).toBe(true);
    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
  });

  it('does not bind, mutate, or clear any session', async () => {
    authMock.hasAnyAdmin.mockResolvedValue(false);

    sessionStore.bind(SENDER, {
      userId: 'u-existing',
      role: 'Cashier',
      sessionId: 'pre-existing',
      createdAt: new Date(),
    });

    await invokeHandlerForTest('setup:isRequired', SENDER, undefined as never);

    // Pre-existing binding survives the probe — the channel is read-only.
    expect(sessionStore.get(SENDER)?.sessionId).toBe('pre-existing');
  });

  it('converts a thrown service error into INTERNAL via the router', async () => {
    authMock.hasAnyAdmin.mockRejectedValue(new Error('db unavailable'));

    const result = await invokeHandlerForTest('setup:isRequired', SENDER, undefined as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
    }
  });
});
