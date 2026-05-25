import bcrypt from 'bcrypt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `AuthService` (Phase 3, task 3.1).
 *
 * These tests drive the service against an in-memory mock of the Prisma
 * delegate surface (`role.findUnique`, `user.findUnique`, `user.create`,
 * `user.count`) and a real `bcrypt` so the cost-factor assertion exercises
 * the actual hashing path. The session store is the genuine module — we
 * only verify that `logout(senderId)` clears the binding.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------
//
// `vi.mock` is hoisted to the top of the module by Vitest, so the mock
// factory can only reference variables that are themselves hoisted via
// `vi.hoisted`. Keeping the in-memory store inside the `hoisted` block
// also lets each `beforeEach` reset the same arrays the mocks read from.

const mockState = vi.hoisted(() => {
  interface MockRole {
    id: string;
    name: string;
  }
  interface MockUser {
    id: string;
    username: string;
    passwordHash: string;
    roleId: string;
    createdAt: Date;
  }
  interface MockAuditLog {
    id: string;
    actionType: string;
    entityType: string;
    entityId: string;
    previous: string | null;
    next: string | null;
    userId: string | null;
    timestamp: Date;
  }
  interface MockJournalEntry {
    id: string;
    opType: string;
    payload: string;
    timestamp: Date;
  }

  const state = {
    roles: [] as MockRole[],
    users: [] as MockUser[],
    auditLogs: [] as MockAuditLog[],
    journalEntries: [] as MockJournalEntry[],
    nextUserId: 0,
    nextAuditId: 0,
    nextJournalId: 0,
  };

  return {
    state,
    reset(): void {
      state.roles = [
        { id: 'r-admin', name: 'Admin' },
        { id: 'r-cashier', name: 'Cashier' },
      ];
      state.users = [];
      state.auditLogs = [];
      state.journalEntries = [];
      state.nextUserId = 0;
      state.nextAuditId = 0;
      state.nextJournalId = 0;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  function makeRecordNotFound(): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      'An operation failed because it depends on one or more records that were required but not found.',
      { code: 'P2025', clientVersion: 'test' },
    );
  }

  // Build a tx-like proxy that exposes the same delegate surface as
  // the top-level `prisma` object. `$transaction(fn)` invokes `fn(tx)`
  // and returns the result; rollback semantics are NOT modeled (the
  // mock doesn't snapshot state) but that is fine — these tests
  // exercise success paths and explicit error paths, not partial
  // rollback semantics. Integration tier covers atomicity.
  const userDelegate = {
    findUnique: ({
      where,
      include,
    }: {
      where: { username?: string; id?: string };
      include?: { role?: boolean };
    }) => {
      const found = state.users.find(
        (u) =>
          (where.username !== undefined && u.username === where.username) ||
          (where.id !== undefined && u.id === where.id),
      );
      if (!found) return Promise.resolve(null);
      if (include?.role) {
        const role = state.roles.find((r) => r.id === found.roleId);
        return Promise.resolve({ ...found, role });
      }
      return Promise.resolve({ ...found });
    },
    count: ({ where }: { where?: { roleId?: string } }) => {
      if (where?.roleId !== undefined) {
        return Promise.resolve(
          state.users.filter((u) => u.roleId === where.roleId).length,
        );
      }
      return Promise.resolve(state.users.length);
    },
    create: ({
      data,
    }: {
      data: { username: string; passwordHash: string; roleId: string };
    }) => {
      if (state.users.some((u) => u.username === data.username)) {
        const err = new Error('Unique constraint failed on the fields: (`username`)');
        (err as { code?: string }).code = 'P2002';
        throw err;
      }
      const user = {
        id: `u-${state.nextUserId++}`,
        username: data.username,
        passwordHash: data.passwordHash,
        roleId: data.roleId,
        createdAt: new Date('2026-05-24T12:00:00.000Z'),
      };
      state.users.push(user);
      return Promise.resolve({ ...user });
    },
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: { roleId?: string };
    }) => {
      const row = state.users.find((u) => u.id === where.id);
      if (!row) {
        throw makeRecordNotFound();
      }
      if (data.roleId !== undefined) row.roleId = data.roleId;
      return Promise.resolve({ ...row });
    },
  };

  const roleDelegate = {
    findUnique: ({ where }: { where: { name?: string; id?: string } }) => {
      const found = state.roles.find(
        (r) =>
          (where.name !== undefined && r.name === where.name) ||
          (where.id !== undefined && r.id === where.id),
      );
      return Promise.resolve(found ?? null);
    },
  };

  const auditLogDelegate = {
    create: ({
      data,
    }: {
      data: {
        actionType: string;
        entityType: string;
        entityId: string;
        previous?: string | null;
        next?: string | null;
        userId?: string | null;
      };
    }) => {
      const row = {
        id: `audit-${state.nextAuditId++}`,
        actionType: data.actionType,
        entityType: data.entityType,
        entityId: data.entityId,
        previous: data.previous ?? null,
        next: data.next ?? null,
        userId: data.userId ?? null,
        timestamp: new Date('2026-05-24T12:00:00.000Z'),
      };
      state.auditLogs.push(row);
      return Promise.resolve({ ...row });
    },
  };

  const journalEntryDelegate = {
    create: ({
      data,
    }: {
      data: { opType: string; payload: string };
    }) => {
      const row = {
        id: `journal-${state.nextJournalId++}`,
        opType: data.opType,
        payload: data.payload,
        timestamp: new Date('2026-05-24T12:00:00.000Z'),
      };
      state.journalEntries.push(row);
      return Promise.resolve({ ...row });
    },
  };

  const tx = {
    user: userDelegate,
    role: roleDelegate,
    auditLog: auditLogDelegate,
    journalEntry: journalEntryDelegate,
  };

  return {
    prisma: {
      role: roleDelegate,
      user: userDelegate,
      auditLog: auditLogDelegate,
      journalEntry: journalEntryDelegate,
      $transaction: <T>(fn: (handle: typeof tx) => Promise<T>): Promise<T> => {
        return fn(tx);
      },
    },
  };
});

// Imports MUST come after `vi.mock` so the mocked module is wired up first.
import { sessionStore } from '@main/auth/session-store';
import { AuthService, BCRYPT_COST_FACTOR } from '@main/services/auth.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapOk<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) {
    throw new Error(`expected Ok, got Err(${result.error.code})`);
  }
  return result.value;
}

beforeEach(() => {
  mockState.reset();
  sessionStore.clearAll();
});

afterEach(() => {
  sessionStore.clearAll();
});

// ---------------------------------------------------------------------------
// hasAnyAdmin
// ---------------------------------------------------------------------------

describe('AuthService.hasAnyAdmin', () => {
  it('returns false on an empty user table', async () => {
    expect(await AuthService.hasAnyAdmin()).toBe(false);
  });

  it('returns true once an Admin user exists', async () => {
    await AuthService.createInitialAdmin('owner', 'correct horse battery staple');
    expect(await AuthService.hasAnyAdmin()).toBe(true);
  });

  it('returns false when only a Cashier user exists (no Admin)', async () => {
    mockState.state.users.push({
      id: 'u-cashier',
      username: 'cashier-1',
      passwordHash: await bcrypt.hash('passw0rd!', 4),
      roleId: 'r-cashier',
      createdAt: new Date(),
    });
    expect(await AuthService.hasAnyAdmin()).toBe(false);
  });

  it('returns false when the Admin role row is missing entirely', async () => {
    mockState.state.roles = mockState.state.roles.filter((r) => r.name !== 'Admin');
    expect(await AuthService.hasAnyAdmin()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createInitialAdmin
// ---------------------------------------------------------------------------

describe('AuthService.createInitialAdmin', () => {
  it('succeeds on first call and returns a SessionDTO + UserDTO', async () => {
    const result = await AuthService.createInitialAdmin('admin', 'super-secret-1');
    const value = unwrapOk(result);

    expect(value.user.username).toBe('admin');
    expect(value.user.roleName).toBe('Admin');
    expect(value.user.roleId).toBe('r-admin');
    expect(value.user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(value.sessionDTO.role).toBe('Admin');
    expect(value.sessionDTO.username).toBe('admin');
    expect(value.sessionDTO.userId).toBe(value.user.id);
    expect(value.sessionDTO.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('returns FORBIDDEN with reason=admin_already_exists on a second call', async () => {
    const first = await AuthService.createInitialAdmin('admin', 'super-secret-1');
    expect(first.ok).toBe(true);

    const second = await AuthService.createInitialAdmin('admin2', 'super-secret-2');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('FORBIDDEN');
      expect(second.error.details).toEqual({ reason: 'admin_already_exists' });
    }
  });

  it('hashes the password with bcrypt cost factor 12 (Req 1.3)', async () => {
    await AuthService.createInitialAdmin('admin', 'super-secret-1');
    const stored = mockState.state.users[0]!;

    // bcrypt hash format: $<algo>$<cost>$<salt+hash>
    // Modern Node bcrypt emits `$2b$`; some platforms still emit `$2a$`.
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(stored.passwordHash.startsWith(`$2b$${BCRYPT_COST_FACTOR}$`)).toBe(true);

    // And the hash actually verifies the password it was made from.
    expect(await bcrypt.compare('super-secret-1', stored.passwordHash)).toBe(true);
    expect(await bcrypt.compare('wrong-password', stored.passwordHash)).toBe(false);
  });

  it('returns VALIDATION { field: "username" } on empty / whitespace usernames', async () => {
    for (const bad of ['', '   ', '\n\t']) {
      const result = await AuthService.createInitialAdmin(bad, 'super-secret-1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION');
        expect(result.error.details).toEqual({ field: 'username' });
      }
    }
  });

  it('returns VALIDATION { field: "username" } when username exceeds 50 characters', async () => {
    const longName = 'a'.repeat(51);
    const result = await AuthService.createInitialAdmin(longName, 'super-secret-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toEqual({ field: 'username' });
    }
  });

  it('returns VALIDATION { field: "password" } on passwords shorter than 8 characters', async () => {
    for (const bad of ['', 'short', '1234567']) {
      const result = await AuthService.createInitialAdmin('admin', bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION');
        expect(result.error.details).toEqual({ field: 'password' });
      }
    }
  });

  it('reports username failures before password failures', async () => {
    // If both are invalid, the field reported is the first one validated.
    const result = await AuthService.createInitialAdmin('', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toEqual({ field: 'username' });
    }
  });

  it('returns DB_INTEGRITY when the Admin role row is missing', async () => {
    mockState.state.roles = mockState.state.roles.filter((r) => r.name !== 'Admin');
    const result = await AuthService.createInitialAdmin('admin', 'super-secret-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DB_INTEGRITY');
    }
  });

  it('does not include passwordHash in the returned SessionDTO or UserDTO', async () => {
    const result = await AuthService.createInitialAdmin('admin', 'super-secret-1');
    const value = unwrapOk(result);
    expect((value.sessionDTO as Record<string, unknown>).passwordHash).toBeUndefined();
    expect((value.user as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('trims surrounding whitespace from the username before persisting', async () => {
    const result = await AuthService.createInitialAdmin('   owner  ', 'super-secret-1');
    const value = unwrapOk(result);
    expect(value.user.username).toBe('owner');
    expect(mockState.state.users[0]?.username).toBe('owner');
  });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe('AuthService.login', () => {
  beforeEach(async () => {
    // Seed one admin via the service so the password hash is real.
    await AuthService.createInitialAdmin('owner', 'super-secret-1');
  });

  it('succeeds with correct credentials and returns a SessionDTO', async () => {
    const result = await AuthService.login('owner', 'super-secret-1');
    const session = unwrapOk(result);
    expect(session.username).toBe('owner');
    expect(session.role).toBe('Admin');
    expect(session.userId).toBe(mockState.state.users[0]!.id);
    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('allocates a fresh sessionId on each successful login', async () => {
    const a = unwrapOk(await AuthService.login('owner', 'super-secret-1'));
    const b = unwrapOk(await AuthService.login('owner', 'super-secret-1'));
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('returns UNAUTHENTICATED on a wrong password', async () => {
    const result = await AuthService.login('owner', 'WRONG-password-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('returns UNAUTHENTICATED for an unknown username', async () => {
    const result = await AuthService.login('ghost-user', 'super-secret-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('returns UNAUTHENTICATED for empty / whitespace usernames', async () => {
    for (const bad of ['', '   ']) {
      const result = await AuthService.login(bad, 'super-secret-1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHENTICATED');
      }
    }
  });

  it('does not leak passwordHash on the success path', async () => {
    const session = unwrapOk(await AuthService.login('owner', 'super-secret-1'));
    expect((session as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('returns the Cashier role when the user is a Cashier', async () => {
    // Insert a Cashier directly (bypassing AuthService.createInitialAdmin
    // which is Admin-only) using a real bcrypt hash.
    mockState.state.users.push({
      id: 'u-cashier',
      username: 'cashier-1',
      passwordHash: await bcrypt.hash('cashier-pw-1', BCRYPT_COST_FACTOR),
      roleId: 'r-cashier',
      createdAt: new Date(),
    });

    const session = unwrapOk(await AuthService.login('cashier-1', 'cashier-pw-1'));
    expect(session.role).toBe('Cashier');
    expect(session.username).toBe('cashier-1');
  });

  it('returns DB_INTEGRITY when the user is bound to an unknown role name', async () => {
    mockState.state.roles.push({ id: 'r-bogus', name: 'BogusRole' });
    mockState.state.users.push({
      id: 'u-bogus',
      username: 'bogus-1',
      passwordHash: await bcrypt.hash('bogus-pw-1', 4),
      roleId: 'r-bogus',
      createdAt: new Date(),
    });

    const result = await AuthService.login('bogus-1', 'bogus-pw-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DB_INTEGRITY');
    }
  });
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

describe('AuthService.logout', () => {
  it('clears the session bound to the renderer (senderId)', async () => {
    sessionStore.bind(42, {
      userId: 'u-1',
      role: 'Admin',
      sessionId: 's-1',
      createdAt: new Date(),
    });
    expect(sessionStore.get(42)).toBeDefined();

    const result = await AuthService.logout(42);
    expect(result.ok).toBe(true);
    expect(sessionStore.get(42)).toBeUndefined();
  });

  it('is idempotent on an unknown senderId', async () => {
    const result = await AuthService.logout(9999);
    expect(result.ok).toBe(true);
  });

  it('does not clear other renderers bindings', async () => {
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

    await AuthService.logout(1);

    expect(sessionStore.get(1)).toBeUndefined();
    expect(sessionStore.get(2)?.userId).toBe('u-2');
  });
});

// ---------------------------------------------------------------------------
// assignRole (Phase 12, task 12.2)
// ---------------------------------------------------------------------------

describe('AuthService.assignRole', () => {
  beforeEach(async () => {
    // Seed an Admin user (the actor) and a Cashier user (the target).
    await AuthService.createInitialAdmin('owner', 'super-secret-1');
    mockState.state.users.push({
      id: 'u-target',
      username: 'cashier-1',
      passwordHash: await bcrypt.hash('cashier-pw-1', BCRYPT_COST_FACTOR),
      roleId: 'r-cashier',
      createdAt: new Date('2026-05-24T12:00:00.000Z'),
    });
  });

  it('flips the user role and writes audit + journal rows in one transaction (Req 8.5, 13.2)', async () => {
    const adminId = mockState.state.users[0]!.id;

    const result = await AuthService.assignRole(
      { userId: 'u-target', roleId: 'r-admin' },
      { userId: adminId },
    );

    const value = unwrapOk(result);
    expect(value.id).toBe('u-target');
    expect(value.roleId).toBe('r-admin');
    expect(value.roleName).toBe('Admin');

    // The user's roleId is updated.
    const user = mockState.state.users.find((u) => u.id === 'u-target')!;
    expect(user.roleId).toBe('r-admin');

    // Exactly one audit row of type role.change with the right shape.
    const auditRows = mockState.state.auditLogs.filter(
      (r) => r.actionType === 'role.change',
    );
    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0]!;
    expect(audit.entityType).toBe('user');
    expect(audit.entityId).toBe('u-target');
    expect(audit.userId).toBe(adminId);
    expect(JSON.parse(audit.previous!)).toEqual({
      roleId: 'r-cashier',
      roleName: 'Cashier',
    });
    expect(JSON.parse(audit.next!)).toEqual({
      roleId: 'r-admin',
      roleName: 'Admin',
    });

    // Exactly one journal row of opType role.change with the full payload.
    const journalRows = mockState.state.journalEntries.filter(
      (r) => r.opType === 'role.change',
    );
    expect(journalRows).toHaveLength(1);
    const payload = JSON.parse(journalRows[0]!.payload) as {
      targetUserId: string;
      previousRole: { roleId: string; roleName: string };
      newRole: { roleId: string; roleName: string };
      userId: string;
      timestamp: string;
    };
    expect(payload.targetUserId).toBe('u-target');
    expect(payload.previousRole).toEqual({ roleId: 'r-cashier', roleName: 'Cashier' });
    expect(payload.newRole).toEqual({ roleId: 'r-admin', roleName: 'Admin' });
    expect(payload.userId).toBe(adminId);
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns Ok and writes no audit row when the new role equals the current role (no-op short-circuit)', async () => {
    const adminId = mockState.state.users[0]!.id;
    const result = await AuthService.assignRole(
      { userId: 'u-target', roleId: 'r-cashier' },
      { userId: adminId },
    );
    const value = unwrapOk(result);
    expect(value.id).toBe('u-target');
    expect(value.roleId).toBe('r-cashier');
    expect(mockState.state.auditLogs.filter((r) => r.actionType === 'role.change')).toEqual([]);
    expect(mockState.state.journalEntries.filter((r) => r.opType === 'role.change')).toEqual([]);
  });

  it('returns FK_VIOLATION { reason: "not_found", field: "userId" } for an unknown target user', async () => {
    const adminId = mockState.state.users[0]!.id;
    const result = await AuthService.assignRole(
      { userId: 'u-ghost', roleId: 'r-admin' },
      { userId: adminId },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toMatchObject({ reason: 'not_found', field: 'userId' });
    }
    expect(mockState.state.auditLogs).toEqual([]);
    expect(mockState.state.journalEntries).toEqual([]);
  });

  it('returns FK_VIOLATION { reason: "not_found", field: "roleId" } for an unknown role', async () => {
    const adminId = mockState.state.users[0]!.id;
    const result = await AuthService.assignRole(
      { userId: 'u-target', roleId: 'r-ghost' },
      { userId: adminId },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toMatchObject({ reason: 'not_found', field: 'roleId' });
    }
    expect(mockState.state.auditLogs).toEqual([]);
    expect(mockState.state.journalEntries).toEqual([]);
  });

  it.each([
    ['', 'userId', 'r-admin', 'userId'],
    ['u-target', 'roleId', '', 'roleId'],
  ])(
    'returns VALIDATION { field } on empty/invalid input',
    async (uid, _label, rid, expectedField) => {
      const result = await AuthService.assignRole(
        { userId: uid, roleId: rid },
        { userId: 'admin-x' },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION');
        expect(result.error.details).toEqual({ field: expectedField });
      }
    },
  );

  it('returns DB_INTEGRITY when the new role row carries a stray name', async () => {
    mockState.state.roles.push({ id: 'r-bogus', name: 'BogusRole' });
    const adminId = mockState.state.users[0]!.id;
    const result = await AuthService.assignRole(
      { userId: 'u-target', roleId: 'r-bogus' },
      { userId: adminId },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DB_INTEGRITY');
    }
  });

  it('writes the audit + journal rows with the acting user attribution from ctx', async () => {
    // Seed a SECOND admin so we can assert the `userId` on the audit
    // row reflects whoever performed the change, not the target.
    mockState.state.users.push({
      id: 'u-admin2',
      username: 'admin2',
      passwordHash: await bcrypt.hash('super-secret-2', BCRYPT_COST_FACTOR),
      roleId: 'r-admin',
      createdAt: new Date('2026-05-24T12:00:00.000Z'),
    });

    const result = await AuthService.assignRole(
      { userId: 'u-target', roleId: 'r-admin' },
      { userId: 'u-admin2' },
    );
    expect(result.ok).toBe(true);

    const audit = mockState.state.auditLogs.find((r) => r.actionType === 'role.change')!;
    expect(audit.userId).toBe('u-admin2');
    const payload = JSON.parse(
      mockState.state.journalEntries.find((r) => r.opType === 'role.change')!.payload,
    ) as { userId: string };
    expect(payload.userId).toBe('u-admin2');
  });
});
