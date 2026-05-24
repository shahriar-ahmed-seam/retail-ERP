import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionStore } from '@main/auth/session-store';
import {
  clearHandlers,
  invokeHandlerForTest,
  registerHandler,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { Session } from '@main/auth/session-store';
import type {
  AuditWriteInput,
  AuditWriter,
  HandlerContext,
  HandlerFn,
} from '@main/ipc/router';

/**
 * Unit tests for the IPC router middleware chain (task 2.4).
 *
 * Driven through the `invokeHandlerForTest` seam so the chain runs without
 * Electron's `ipcMain` — the test seam shares its implementation with the
 * production `ipcMain.handle` binding so production semantics cannot drift.
 *
 * The `audit_logs` writer is replaced with an in-memory recorder via
 * `setAuditWriter` so tests can assert audit attempts without touching
 * Prisma / SQLite.
 *
 * Validates: Requirements 1.5, 8.4, 13.4.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    userId: overrides.userId ?? 'u-1',
    role: overrides.role ?? 'Admin',
    sessionId: overrides.sessionId ?? 's-1',
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}

class RecordingAuditWriter implements AuditWriter {
  public readonly rows: AuditWriteInput[] = [];
  public failNext = false;

  public write(input: AuditWriteInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('simulated audit write failure'));
    }
    this.rows.push(input);
    return Promise.resolve();
  }
}

let recorder: RecordingAuditWriter;

beforeEach(() => {
  // Silence the router's defensive `console.error` calls; tests inspect
  // the audit recorder + returned envelopes, not stdout.
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* noop */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);
});

afterEach(() => {
  resetAuditWriter();
  clearHandlers();
  sessionStore.clearAll();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

describe('auth middleware', () => {
  it('rejects calls with no session on a default (requiresAuth) channel', async () => {
    let called = false;
    const handler: HandlerFn<'pos:scan'> = () => {
      called = true;
      return Promise.resolve(Ok(null));
    };
    // `pos:scan` is a real channel that defaults to requiresAuth and is
    // allowed for both Admin and Cashier — perfect for the no-session case.
    registerHandler('pos:scan', {}, handler);

    const result = await invokeHandlerForTest('pos:scan', /*senderId*/ 1, { barcode: 'X' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNAUTHENTICATED');
    expect(called).toBe(false);
    expect(recorder.rows).toEqual([]);
  });

  it('allows calls with a bound session on a default (requiresAuth) channel', async () => {
    let captured: HandlerContext | undefined;
    const handler: HandlerFn<'pos:scan'> = (_req, ctx) => {
      captured = ctx;
      return Promise.resolve(Ok(null));
    };
    registerHandler('pos:scan', {}, handler);

    sessionStore.bind(7, makeSession({ userId: 'u-7', role: 'Cashier' }));
    const result = await invokeHandlerForTest('pos:scan', 7, { barcode: 'X' });

    expect(result.ok).toBe(true);
    expect(captured).toBeDefined();
    expect(captured?.session?.userId).toBe('u-7');
    expect(captured?.session?.role).toBe('Cashier');
    expect(captured?.senderId).toBe(7);
  });

  it('lets requiresAuth: false channels through with no session', async () => {
    let captured: HandlerContext | undefined;
    const handler: HandlerFn<'auth:login'> = (_req, ctx) => {
      captured = ctx;
      return Promise.resolve(
        Ok({
          sessionId: 's-bootstrap',
          userId: 'u-1',
          username: 'root',
          role: 'Admin' as const,
        }),
      );
    };
    // `auth:login` is the canonical public channel.
    registerHandler('auth:login', { requiresAuth: false }, handler);

    const result = await invokeHandlerForTest('auth:login', 99, {
      username: 'root',
      password: 'pw',
    });

    expect(result.ok).toBe(true);
    // Public channels also bypass RBAC, so no rbac.deny rows leak through.
    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
    // Context has no session even though the handler ran.
    expect(captured?.session).toBeUndefined();
    expect(captured?.senderId).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// RBAC middleware
// ---------------------------------------------------------------------------

describe('rbac middleware', () => {
  it('denies a Cashier on an Admin-only channel and writes an rbac.deny audit row', async () => {
    let called = false;
    const handler: HandlerFn<'inventory:adjust'> = () => {
      called = true;
      return Promise.resolve(Ok({ movementId: 'm-1' }));
    };
    // `inventory:adjust` is Admin-only per the static matrix.
    registerHandler('inventory:adjust', {}, handler);

    sessionStore.bind(3, makeSession({ userId: 'u-cashier', role: 'Cashier', sessionId: 's-c' }));
    const result = await invokeHandlerForTest('inventory:adjust', 3, {
      productId: 'p-1',
      delta: -1,
      reason: 'shrinkage',
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'inventory:adjust' });
    }
    expect(called).toBe(false);

    expect(recorder.rows).toHaveLength(1);
    const audit = recorder.rows[0]!;
    expect(audit.actionType).toBe('rbac.deny');
    expect(audit.entityType).toBe('ipc');
    expect(audit.entityId).toBe('inventory:adjust');
    expect(audit.userId).toBe('u-cashier');
    expect(audit.next).toEqual({ channel: 'inventory:adjust', role: 'Cashier' });
  });

  it('still returns FORBIDDEN even if the rbac.deny audit write fails', async () => {
    let called = false;
    const handler: HandlerFn<'inventory:adjust'> = () => {
      called = true;
      return Promise.resolve(Ok({ movementId: 'm-1' }));
    };
    registerHandler('inventory:adjust', {}, handler);

    sessionStore.bind(3, makeSession({ userId: 'u-cashier', role: 'Cashier' }));
    recorder.failNext = true;

    const result = await invokeHandlerForTest('inventory:adjust', 3, {
      productId: 'p-1',
      delta: -1,
      reason: 'shrinkage',
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    expect(called).toBe(false);
  });

  it('allows an Admin on an Admin-only channel', async () => {
    let called = false;
    const handler: HandlerFn<'inventory:adjust'> = () => {
      called = true;
      return Promise.resolve(Ok({ movementId: 'm-1' }));
    };
    registerHandler('inventory:adjust', {}, handler);

    sessionStore.bind(2, makeSession({ userId: 'u-admin', role: 'Admin' }));
    const result = await invokeHandlerForTest('inventory:adjust', 2, {
      productId: 'p-1',
      delta: -1,
      reason: 'shrinkage',
    } as never);

    expect(result.ok).toBe(true);
    expect(called).toBe(true);
    // No rbac.deny row should have been written for an allowed call.
    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Audit middleware (declarative descriptor)
// ---------------------------------------------------------------------------

describe('audit middleware', () => {
  it('writes an audit row from the descriptor when the handler returns Ok', async () => {
    const handler: HandlerFn<'users:assignRole'> = () =>
      Promise.resolve(
        Ok({
          id: 'u-2',
          username: 'bob',
          roleId: 'r-cashier',
          roleName: 'Cashier' as const,
          createdAt: '2026-01-02T00:00:00.000Z',
        }),
      );
    // `users:assignRole` is the canonical declarative-audit channel
    // (role.change goes through the middleware, not the service tx).
    registerHandler(
      'users:assignRole',
      {
        audit: {
          actionType: 'role.change',
          entityType: 'user',
          entityId: (req) => req.userId,
          extractPrevious: (req) => ({ targetUserId: req.userId }),
          extractNext: (req, res) => ({ roleId: req.roleId, roleName: res.roleName }),
        },
      },
      handler,
    );

    sessionStore.bind(1, makeSession({ userId: 'u-admin', role: 'Admin', sessionId: 's-admin' }));
    const result = await invokeHandlerForTest('users:assignRole', 1, {
      userId: 'u-2',
      roleId: 'r-cashier',
    });

    expect(result.ok).toBe(true);
    expect(recorder.rows).toHaveLength(1);
    const audit = recorder.rows[0]!;
    expect(audit.actionType).toBe('role.change');
    expect(audit.entityType).toBe('user');
    expect(audit.entityId).toBe('u-2');
    expect(audit.userId).toBe('u-admin');
    expect(audit.previous).toEqual({ targetUserId: 'u-2' });
    expect(audit.next).toEqual({ roleId: 'r-cashier', roleName: 'Cashier' });
  });

  it('does not write an audit row when the handler returns Err', async () => {
    const handler: HandlerFn<'users:assignRole'> = () =>
      Promise.resolve(Err('VALIDATION', { field: 'roleId' }));
    registerHandler(
      'users:assignRole',
      {
        audit: {
          actionType: 'role.change',
          entityType: 'user',
          entityId: (req) => req.userId,
        },
      },
      handler,
    );

    sessionStore.bind(1, makeSession({ userId: 'u-admin', role: 'Admin' }));
    const result = await invokeHandlerForTest('users:assignRole', 1, {
      userId: 'u-2',
      roleId: 'bogus',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(recorder.rows).toEqual([]);
  });

  it('preserves the handler result when the audit write itself fails', async () => {
    const handler: HandlerFn<'users:assignRole'> = () =>
      Promise.resolve(
        Ok({
          id: 'u-2',
          username: 'bob',
          roleId: 'r-cashier',
          roleName: 'Cashier' as const,
          createdAt: '2026-01-02T00:00:00.000Z',
        }),
      );
    registerHandler(
      'users:assignRole',
      {
        audit: {
          actionType: 'role.change',
          entityType: 'user',
          entityId: (req) => req.userId,
        },
      },
      handler,
    );

    sessionStore.bind(1, makeSession({ userId: 'u-admin', role: 'Admin' }));
    recorder.failNext = true;

    const result = await invokeHandlerForTest('users:assignRole', 1, {
      userId: 'u-2',
      roleId: 'r-cashier',
    });

    // Audit failures must not turn a successful handler into an error —
    // doing so would let a transient SQLITE_BUSY revert a committed
    // business operation.
    expect(result.ok).toBe(true);
    expect(recorder.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Handler exception → INTERNAL
// ---------------------------------------------------------------------------

describe('handler exceptions', () => {
  it('converts a thrown exception inside the handler to Err(INTERNAL) with errorId', async () => {
    let called = false;
    const handler: HandlerFn<'pos:scan'> = () => {
      called = true;
      throw new Error('boom');
    };
    registerHandler('pos:scan', {}, handler);

    sessionStore.bind(5, makeSession({ userId: 'u-5', role: 'Cashier' }));
    const result = await invokeHandlerForTest('pos:scan', 5, { barcode: 'Z' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(typeof result.error.errorId).toBe('string');
      expect(result.error.errorId?.length ?? 0).toBeGreaterThan(0);
    }
    expect(called).toBe(true);
    // No audit row should be written for an internal failure unless a
    // descriptor is configured AND the handler returned Ok (it didn't).
    expect(recorder.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unknown-channel safety net
// ---------------------------------------------------------------------------

describe('unregistered channel', () => {
  it('returns Err(INTERNAL) when no handler is registered for the channel', async () => {
    sessionStore.bind(1, makeSession());
    const result = await invokeHandlerForTest('pos:scan', 1, { barcode: 'X' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      expect(result.error.details).toEqual({ channel: 'pos:scan' });
    }
  });
});
