import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `AuditService` (Phase 12, task 12.1).
 *
 * Drives the service against an in-memory mock of the Prisma
 * `auditLog` and `user` delegates. The tests cover:
 *
 *   - Cursor-paginated `list` against `(timestamp DESC, id DESC)`.
 *   - Filter compilation: `actionType`, `userId`,
 *     `dateFrom`/`dateTo` window.
 *   - Per-page `userId → username` resolution.
 *   - `withCount` opt-in surfaces `totalCount`; otherwise omitted.
 *   - Companion `count` against the same filter shape.
 *   - Malformed cursor → `Err('VALIDATION', { field: 'cursor' })`.
 *
 * Validates: Requirements 13.1, 13.2, 13.3, 13.4, 16.1, 16.2, 16.3,
 *            16.4.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
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
  interface MockUser {
    id: string;
    username: string;
  }

  const state = {
    auditLogs: [] as MockAuditLog[],
    users: [] as MockUser[],
  };

  return {
    state,
    reset(): void {
      state.auditLogs = [];
      state.users = [];
    },
  };
});

vi.mock('@main/db/prisma.js', () => {
  const { state } = mockState;

  type Op = 'lt' | 'lte' | 'gt' | 'gte' | 'equals' | 'in';

  function matches(
    row: Record<string, unknown>,
    where: Record<string, unknown> | undefined,
  ): boolean {
    if (where === undefined || Object.keys(where).length === 0) return true;
    for (const [key, raw] of Object.entries(where)) {
      if (key === 'AND') {
        const arr = raw as readonly Record<string, unknown>[];
        if (!arr.every((w) => matches(row, w))) return false;
        continue;
      }
      if (key === 'OR') {
        const arr = raw as readonly Record<string, unknown>[];
        if (!arr.some((w) => matches(row, w))) return false;
        continue;
      }
      const fieldValue = row[key];
      if (raw !== null && typeof raw === 'object') {
        const cmp = raw as Record<string, unknown>;
        for (const [op, target] of Object.entries(cmp)) {
          if (!compareOp(fieldValue, op as Op, target)) return false;
        }
        continue;
      }
      if (fieldValue !== raw) return false;
    }
    return true;
  }

  function compareOp(field: unknown, op: Op, target: unknown): boolean {
    switch (op) {
      case 'equals':
        return field === target;
      case 'lt':
        return (field as never) < (target as never);
      case 'lte':
        return (field as never) <= (target as never);
      case 'gt':
        return (field as never) > (target as never);
      case 'gte':
        return (field as never) >= (target as never);
      case 'in':
        return Array.isArray(target) && (target as unknown[]).includes(field);
      default:
        throw new Error(`unsupported comparator op: ${op as string}`);
    }
  }

  function compareRows(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    orderBy: readonly Record<string, 'asc' | 'desc'>[],
  ): number {
    for (const clause of orderBy) {
      for (const [key, dir] of Object.entries(clause)) {
        const av = a[key];
        const bv = b[key];
        if ((av as never) < (bv as never)) return dir === 'asc' ? -1 : 1;
        if ((av as never) > (bv as never)) return dir === 'asc' ? 1 : -1;
      }
    }
    return 0;
  }

  return {
    prisma: {
      auditLog: {
        findMany: ({
          where,
          orderBy,
          take,
        }: {
          where?: Record<string, unknown>;
          orderBy?: readonly Record<string, 'asc' | 'desc'>[];
          take?: number;
        }) => {
          let rows = state.auditLogs.filter((r) =>
            matches(r as unknown as Record<string, unknown>, where),
          );
          if (orderBy && orderBy.length > 0) {
            rows = [...rows].sort((a, b) =>
              compareRows(
                a as unknown as Record<string, unknown>,
                b as unknown as Record<string, unknown>,
                orderBy,
              ),
            );
          }
          if (typeof take === 'number') rows = rows.slice(0, take);
          return Promise.resolve(rows.map((r) => ({ ...r })));
        },
        count: ({ where }: { where?: Record<string, unknown> }) => {
          const n = state.auditLogs.filter((r) =>
            matches(r as unknown as Record<string, unknown>, where),
          ).length;
          return Promise.resolve(n);
        },
      },
      user: {
        findMany: ({
          where,
          select,
        }: {
          where?: { id?: { in?: string[] } };
          select?: { id?: boolean; username?: boolean };
        }) => {
          const ids = where?.id?.in ?? [];
          const rows = state.users.filter((u) => ids.includes(u.id));
          if (select) {
            return Promise.resolve(
              rows.map((r) => ({
                ...(select.id === true ? { id: r.id } : {}),
                ...(select.username === true ? { username: r.username } : {}),
              })),
            );
          }
          return Promise.resolve(rows.map((r) => ({ ...r })));
        },
      },
    },
  };
});

// Imports MUST come after `vi.mock`.
import { AuditService } from '@main/services/audit.service';

import type { AuditActionType } from '@shared/dto/index';

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

function seedUser(id: string, username: string): void {
  mockState.state.users.push({ id, username });
}

function seedAuditLog(args: {
  id: string;
  actionType: AuditActionType;
  entityType?: string;
  entityId?: string;
  previous?: unknown;
  next?: unknown;
  userId?: string | null;
  timestamp?: Date;
}): void {
  mockState.state.auditLogs.push({
    id: args.id,
    actionType: args.actionType,
    entityType: args.entityType ?? 'product',
    entityId: args.entityId ?? 'p-1',
    previous: args.previous === undefined ? null : JSON.stringify(args.previous),
    next: args.next === undefined ? null : JSON.stringify(args.next),
    userId: args.userId === undefined ? 'u-admin' : args.userId,
    timestamp: args.timestamp ?? new Date('2026-05-24T12:00:00.000Z'),
  });
}

beforeEach(() => {
  mockState.reset();
});

afterEach(() => {
  mockState.reset();
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('AuditService.list', () => {
  it('returns rows ordered by (timestamp DESC, id DESC) by default', async () => {
    seedUser('u-admin', 'owner');
    seedAuditLog({
      id: 'a-1',
      actionType: 'price.change',
      timestamp: new Date('2026-05-24T10:00:00.000Z'),
    });
    seedAuditLog({
      id: 'a-2',
      actionType: 'role.change',
      timestamp: new Date('2026-05-24T12:00:00.000Z'),
    });
    seedAuditLog({
      id: 'a-3',
      actionType: 'stock.adjust',
      timestamp: new Date('2026-05-24T11:00:00.000Z'),
    });

    const value = unwrapOk(await AuditService.list({ pageSize: 10 }));
    expect(value.rows.map((r) => r.id)).toEqual(['a-2', 'a-3', 'a-1']);
    expect(value.nextCursor).toBeNull();
  });

  it('resolves userId → userName via a batched lookup', async () => {
    seedUser('u-admin', 'owner');
    seedUser('u-cashier', 'cash-1');
    seedAuditLog({ id: 'a-1', actionType: 'price.change', userId: 'u-admin' });
    seedAuditLog({
      id: 'a-2',
      actionType: 'rbac.deny',
      userId: 'u-cashier',
      timestamp: new Date('2026-05-24T13:00:00.000Z'),
    });
    seedAuditLog({
      id: 'a-3',
      actionType: 'backup.restore',
      userId: null,
      timestamp: new Date('2026-05-24T14:00:00.000Z'),
    });

    const value = unwrapOk(await AuditService.list({ pageSize: 10 }));
    const byId = new Map(value.rows.map((r) => [r.id, r]));
    expect(byId.get('a-1')?.userName).toBe('owner');
    expect(byId.get('a-2')?.userName).toBe('cash-1');
    expect(byId.get('a-3')?.userName).toBeNull();
    expect(byId.get('a-3')?.userId).toBeNull();
  });

  it('parses previous and next JSON snapshots into structured values', async () => {
    seedUser('u-admin', 'owner');
    seedAuditLog({
      id: 'a-1',
      actionType: 'role.change',
      previous: { roleId: 'r-cashier', roleName: 'Cashier' },
      next: { roleId: 'r-admin', roleName: 'Admin' },
    });
    const value = unwrapOk(await AuditService.list({ pageSize: 10 }));
    const row = value.rows[0]!;
    expect(row.previous).toEqual({ roleId: 'r-cashier', roleName: 'Cashier' });
    expect(row.next).toEqual({ roleId: 'r-admin', roleName: 'Admin' });
  });

  it('filters by actionType', async () => {
    seedUser('u-admin', 'owner');
    seedAuditLog({ id: 'a-1', actionType: 'price.change' });
    seedAuditLog({ id: 'a-2', actionType: 'role.change' });
    seedAuditLog({ id: 'a-3', actionType: 'stock.adjust' });

    const value = unwrapOk(
      await AuditService.list({ filter: { actionType: 'role.change' }, pageSize: 10 }),
    );
    expect(value.rows.map((r) => r.id)).toEqual(['a-2']);
  });

  it('filters by userId', async () => {
    seedUser('u-admin', 'owner');
    seedUser('u-other', 'other');
    seedAuditLog({ id: 'a-1', actionType: 'price.change', userId: 'u-admin' });
    seedAuditLog({ id: 'a-2', actionType: 'price.change', userId: 'u-other' });

    const value = unwrapOk(
      await AuditService.list({ filter: { userId: 'u-admin' }, pageSize: 10 }),
    );
    expect(value.rows.map((r) => r.id)).toEqual(['a-1']);
  });

  it('filters by inclusive [dateFrom, dateTo] window', async () => {
    seedUser('u-admin', 'owner');
    seedAuditLog({
      id: 'a-1',
      actionType: 'price.change',
      timestamp: new Date('2026-05-23T10:00:00.000Z'),
    });
    seedAuditLog({
      id: 'a-2',
      actionType: 'price.change',
      timestamp: new Date('2026-05-24T10:00:00.000Z'),
    });
    seedAuditLog({
      id: 'a-3',
      actionType: 'price.change',
      timestamp: new Date('2026-05-25T10:00:00.000Z'),
    });

    const value = unwrapOk(
      await AuditService.list({
        filter: {
          dateFrom: '2026-05-24T00:00:00.000Z',
          dateTo: '2026-05-24T23:59:59.999Z',
        },
        pageSize: 10,
      }),
    );
    expect(value.rows.map((r) => r.id)).toEqual(['a-2']);
  });

  it('paginates by cursor (timestamp, id)', async () => {
    seedUser('u-admin', 'owner');
    for (let i = 0; i < 5; i++) {
      seedAuditLog({
        id: `a-${i}`,
        actionType: 'price.change',
        timestamp: new Date(Date.UTC(2026, 4, 24, 10 + i, 0, 0)),
      });
    }

    // Page 1 — pageSize 2, expect newest 2 rows.
    const page1 = unwrapOk(await AuditService.list({ pageSize: 2 }));
    expect(page1.rows.map((r) => r.id)).toEqual(['a-4', 'a-3']);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2 — using nextCursor.
    const page2 = unwrapOk(
      await AuditService.list({ pageSize: 2, cursor: page1.nextCursor! }),
    );
    expect(page2.rows.map((r) => r.id)).toEqual(['a-2', 'a-1']);
    expect(page2.nextCursor).not.toBeNull();

    // Page 3 — last single row, then exhaustion.
    const page3 = unwrapOk(
      await AuditService.list({ pageSize: 2, cursor: page2.nextCursor! }),
    );
    expect(page3.rows.map((r) => r.id)).toEqual(['a-0']);
    expect(page3.nextCursor).toBeNull();
  });

  it('returns VALIDATION { field: "cursor" } for a malformed cursor', async () => {
    const result = await AuditService.list({ cursor: 'not-base64-json' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'cursor' });
    }
  });

  it('includes totalCount when withCount=true', async () => {
    seedUser('u-admin', 'owner');
    for (let i = 0; i < 3; i++) {
      seedAuditLog({
        id: `a-${i}`,
        actionType: 'price.change',
        timestamp: new Date(Date.UTC(2026, 4, 24, 10 + i, 0, 0)),
      });
    }
    const value = unwrapOk(await AuditService.list({ pageSize: 2, withCount: true }));
    expect(value.totalCount).toBe(3);
  });

  it('omits totalCount when withCount is not set', async () => {
    seedUser('u-admin', 'owner');
    seedAuditLog({ id: 'a-1', actionType: 'price.change' });
    const value = unwrapOk(await AuditService.list({ pageSize: 2 }));
    expect(value.totalCount).toBeUndefined();
  });

  it('handles a malformed previous/next JSON column gracefully (returns null)', async () => {
    seedUser('u-admin', 'owner');
    // Inject a row with a malformed JSON string in `previous`.
    mockState.state.auditLogs.push({
      id: 'a-broken',
      actionType: 'price.change',
      entityType: 'product',
      entityId: 'p-1',
      previous: '{not-json',
      next: null,
      userId: 'u-admin',
      timestamp: new Date('2026-05-24T12:00:00.000Z'),
    });
    const value = unwrapOk(await AuditService.list({ pageSize: 5 }));
    expect(value.rows[0]!.previous).toBeNull();
    expect(value.rows[0]!.next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe('AuditService.count', () => {
  it('returns the total row count without filter', async () => {
    seedUser('u-admin', 'owner');
    for (let i = 0; i < 4; i++) {
      seedAuditLog({
        id: `a-${i}`,
        actionType: 'price.change',
        timestamp: new Date(Date.UTC(2026, 4, 24, 10 + i, 0, 0)),
      });
    }
    const value = unwrapOk(await AuditService.count({}));
    expect(value.totalCount).toBe(4);
  });

  it('honours the same filter shape as list', async () => {
    seedUser('u-admin', 'owner');
    seedAuditLog({ id: 'a-1', actionType: 'price.change' });
    seedAuditLog({ id: 'a-2', actionType: 'role.change' });
    seedAuditLog({ id: 'a-3', actionType: 'role.change' });
    const value = unwrapOk(await AuditService.count({ filter: { actionType: 'role.change' } }));
    expect(value.totalCount).toBe(2);
  });
});
