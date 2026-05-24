import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `CustomerService` (Phase 9, task 9.1).
 *
 * Drives the service against an in-memory mock of the Prisma
 * delegates (`customer.findMany`, `customer.findUnique`,
 * `customer.create`, `customer.update`, `customer.count`,
 * `sale.findMany`, `sale.count`). The mock mimics:
 *
 *   - cuid-style id generation on create,
 *   - the absence of UNIQUE constraints on `Customer` (no P2002
 *     mapping is required for this service; the schema only has
 *     `@@index([phone])`),
 *   - Prisma's `P2025` shape for missing-record errors on update,
 *   - the `Customer ←→ Sale` join (with cashier) used by `detail`.
 *
 * Validates: Requirements 7.1, 7.3, 16.1, 16.3, 16.4.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockCustomer {
    id: string;
    name: string;
    phone: string | null;
    createdAt: Date;
  }
  interface MockSale {
    id: string;
    serialNo: string;
    customerId: string | null;
    cashierId: string;
    grandTotal: string;
    createdAt: Date;
  }
  interface MockUser {
    id: string;
    username: string;
  }

  const state = {
    customers: [] as MockCustomer[],
    sales: [] as MockSale[],
    users: [] as MockUser[],
    nextCustomerId: 0,
  };

  return {
    state,
    reset(): void {
      state.customers = [];
      state.sales = [];
      state.users = [];
      state.nextCustomerId = 0;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  type MockCustomer = (typeof state.customers)[number];
  type Op = 'lt' | 'lte' | 'gt' | 'gte' | 'equals' | 'in' | 'startsWith';

  function makeRecordNotFound(): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      'An operation failed because it depends on one or more records that were required but not found.',
      { code: 'P2025', clientVersion: 'test' },
    );
  }

  /** Apply a Prisma-style WhereInput predicate to a row. Supports the
   *  narrow subset the service emits: top-level AND/OR, scalar
   *  equality, comparator objects, `startsWith`. */
  function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
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
      if (raw !== null && typeof raw === 'object' && !(raw instanceof Date)) {
        const cmp = raw as Record<string, unknown>;
        for (const [op, target] of Object.entries(cmp)) {
          if (!compareOp(fieldValue, op as Op, target)) return false;
        }
        continue;
      }
      if (fieldValue instanceof Date && raw instanceof Date) {
        if (fieldValue.getTime() !== raw.getTime()) return false;
        continue;
      }
      if (fieldValue !== raw) return false;
    }
    return true;
  }

  function compareOp(field: unknown, op: Op, target: unknown): boolean {
    // Date comparators need to compare on numeric timestamps.
    const a = field instanceof Date ? field.getTime() : field;
    const b = target instanceof Date ? target.getTime() : target;
    switch (op) {
      case 'equals':
        return a === b;
      case 'lt':
        return (a as never) < (b as never);
      case 'lte':
        return (a as never) <= (b as never);
      case 'gt':
        return (a as never) > (b as never);
      case 'gte':
        return (a as never) >= (b as never);
      case 'in':
        return Array.isArray(b) && (b as unknown[]).includes(a);
      case 'startsWith':
        return (
          typeof field === 'string' &&
          typeof target === 'string' &&
          field.toLowerCase().startsWith(target.toLowerCase())
        );
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
        const ax = av instanceof Date ? av.getTime() : av;
        const bx = bv instanceof Date ? bv.getTime() : bv;
        if ((ax as never) < (bx as never)) return dir === 'asc' ? -1 : 1;
        if ((ax as never) > (bx as never)) return dir === 'asc' ? 1 : -1;
      }
    }
    return 0;
  }

  // ---- Customer delegate ------------------------------------------------
  function customerFindMany({
    where,
    orderBy,
    take,
  }: {
    where?: Record<string, unknown>;
    orderBy?: readonly Record<string, 'asc' | 'desc'>[];
    take?: number;
  }): Promise<MockCustomer[]> {
    let rows = state.customers.filter((r) => matches(r as Record<string, unknown>, where));
    if (orderBy && orderBy.length > 0) {
      rows = [...rows].sort((a, b) =>
        compareRows(a as Record<string, unknown>, b as Record<string, unknown>, orderBy),
      );
    }
    if (typeof take === 'number') rows = rows.slice(0, take);
    return Promise.resolve(rows.map((r) => ({ ...r })));
  }

  function customerFindUnique({
    where,
  }: {
    where: { id?: string };
  }): Promise<MockCustomer | null> {
    const row = state.customers.find((r) => where.id !== undefined && r.id === where.id);
    return Promise.resolve(row ? { ...row } : null);
  }

  function customerCreate({
    data,
  }: {
    data: { name: string; phone?: string | null };
  }): Promise<MockCustomer> {
    const row: MockCustomer = {
      id: `cus-${state.nextCustomerId++}`,
      name: data.name,
      phone: data.phone ?? null,
      createdAt: new Date(),
    };
    state.customers.push(row);
    return Promise.resolve({ ...row });
  }

  function customerUpdate({
    where,
    data,
  }: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<MockCustomer> {
    const row = state.customers.find((r) => r.id === where.id);
    if (!row) {
      throw makeRecordNotFound();
    }
    for (const [k, v] of Object.entries(data)) {
      (row as unknown as Record<string, unknown>)[k] = v;
    }
    return Promise.resolve({ ...row });
  }

  function customerCount({
    where,
  }: {
    where?: Record<string, unknown>;
  }): Promise<number> {
    return Promise.resolve(
      state.customers.filter((r) => matches(r as Record<string, unknown>, where)).length,
    );
  }

  // ---- Sale delegate ----------------------------------------------------
  function saleFindMany({
    where,
    orderBy,
    take,
    include,
  }: {
    where?: Record<string, unknown>;
    orderBy?: readonly Record<string, 'asc' | 'desc'>[];
    take?: number;
    include?: { customer?: unknown; cashier?: unknown };
  }): Promise<unknown[]> {
    let rows = state.sales.filter((r) =>
      matches(r as Record<string, unknown>, where),
    );
    if (orderBy && orderBy.length > 0) {
      rows = [...rows].sort((a, b) =>
        compareRows(a as Record<string, unknown>, b as Record<string, unknown>, orderBy),
      );
    }
    if (typeof take === 'number') rows = rows.slice(0, take);
    return Promise.resolve(
      rows.map((r) => {
        const out: Record<string, unknown> = {
          id: r.id,
          serialNo: r.serialNo,
          customerId: r.customerId,
          cashierId: r.cashierId,
          grandTotal: new Prisma.Decimal(r.grandTotal),
          createdAt: r.createdAt,
        };
        if (include?.customer !== undefined) {
          if (r.customerId === null) {
            out.customer = null;
          } else {
            const c = state.customers.find((cust) => cust.id === r.customerId);
            out.customer = c ? { name: c.name } : null;
          }
        }
        if (include?.cashier !== undefined) {
          const u = state.users.find((usr) => usr.id === r.cashierId);
          out.cashier = u ? { username: u.username } : { username: 'unknown' };
        }
        return out;
      }),
    );
  }

  function saleCount({
    where,
  }: {
    where?: Record<string, unknown>;
  }): Promise<number> {
    return Promise.resolve(
      state.sales.filter((r) => matches(r as Record<string, unknown>, where)).length,
    );
  }

  return {
    prisma: {
      customer: {
        findMany: customerFindMany,
        findUnique: customerFindUnique,
        create: customerCreate,
        update: customerUpdate,
        count: customerCount,
      },
      sale: {
        findMany: saleFindMany,
        count: saleCount,
      },
    },
  };
});

// Imports MUST come after `vi.mock`.
import { CustomerService } from '@main/services/customer.service';

import type { CustomerInput } from '@shared/dto/index';

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

function seedCustomer(overrides: Partial<{
  id: string;
  name: string;
  phone: string | null;
  createdAt: Date;
}> = {}): string {
  const id = overrides.id ?? `cus-seed-${mockState.state.customers.length}`;
  mockState.state.customers.push({
    id,
    name: overrides.name ?? `Name ${id}`,
    phone: overrides.phone ?? null,
    createdAt:
      overrides.createdAt ??
      new Date(`2024-01-${String(mockState.state.customers.length + 1).padStart(2, '0')}T10:00:00Z`),
  });
  return id;
}

function seedUser(overrides: Partial<{ id: string; username: string }> = {}): string {
  const id = overrides.id ?? `usr-${mockState.state.users.length}`;
  mockState.state.users.push({
    id,
    username: overrides.username ?? `cashier-${id}`,
  });
  return id;
}

function seedSale(overrides: Partial<{
  id: string;
  serialNo: string;
  customerId: string | null;
  cashierId: string;
  grandTotal: string;
  createdAt: Date;
}> = {}): string {
  const id = overrides.id ?? `sal-${mockState.state.sales.length}`;
  mockState.state.sales.push({
    id,
    serialNo: overrides.serialNo ?? `INV-${String(mockState.state.sales.length + 1).padStart(6, '0')}`,
    customerId: overrides.customerId ?? null,
    cashierId: overrides.cashierId ?? 'usr-default',
    grandTotal: overrides.grandTotal ?? '100.00',
    createdAt:
      overrides.createdAt ??
      new Date(`2024-02-${String(mockState.state.sales.length + 1).padStart(2, '0')}T10:00:00Z`),
  });
  return id;
}

const baseInput: CustomerInput = {
  name: 'Alice Walker',
  phone: '555-1234',
};

beforeEach(() => {
  mockState.reset();
});

afterEach(() => {
  mockState.reset();
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('CustomerService.list', () => {
  it('returns an empty page on an empty table', async () => {
    const result = await CustomerService.list({});
    const value = unwrapOk(result);
    expect(value.rows).toEqual([]);
    expect(value.nextCursor).toBeNull();
    expect('totalCount' in value).toBe(false);
  });

  it('orders by (name ASC, id ASC) by default (Req 7.1)', async () => {
    seedCustomer({ id: 'a', name: 'Zed' });
    seedCustomer({ id: 'b', name: 'Alice' });
    seedCustomer({ id: 'c', name: 'Maria' });

    const value = unwrapOk(await CustomerService.list({}));
    expect(value.rows.map((r) => r.name)).toEqual(['Alice', 'Maria', 'Zed']);
  });

  it('clamps pageSize to [1, 200]', async () => {
    for (let i = 0; i < 5; i++) {
      seedCustomer({ name: `Cus ${i}` });
    }
    const result = unwrapOk(
      await CustomerService.list({ pageSize: 1_000_000 }),
    );
    expect(result.rows).toHaveLength(5);
  });

  it('paginates by cursor and the walk completes when fewer than pageSize rows return', async () => {
    for (let i = 0; i < 7; i++) {
      seedCustomer({ id: `c-${i}`, name: `Name ${String(i).padStart(2, '0')}` });
    }
    const first = unwrapOk(await CustomerService.list({ pageSize: 3 }));
    expect(first.rows).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows.map((r) => r.name)).toEqual(['Name 00', 'Name 01', 'Name 02']);

    const second = unwrapOk(
      await CustomerService.list({ pageSize: 3, cursor: first.nextCursor! }),
    );
    expect(second.rows.map((r) => r.name)).toEqual(['Name 03', 'Name 04', 'Name 05']);

    const third = unwrapOk(
      await CustomerService.list({ pageSize: 3, cursor: second.nextCursor! }),
    );
    expect(third.rows.map((r) => r.name)).toEqual(['Name 06']);
    expect(third.nextCursor).toBeNull();
  });

  it('returns Err(VALIDATION, { field: "cursor" }) on malformed cursor', async () => {
    seedCustomer();
    const result = await CustomerService.list({ cursor: 'not-base64!!!' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'cursor' });
    }
  });

  it('filters by phonePrefix (case-insensitive prefix on phone)', async () => {
    seedCustomer({ id: 'c-1', name: 'Alice', phone: '555-1234' });
    seedCustomer({ id: 'c-2', name: 'Bob', phone: '555-9999' });
    seedCustomer({ id: 'c-3', name: 'Carol', phone: '777-0000' });

    const value = unwrapOk(
      await CustomerService.list({ filter: { phonePrefix: '555' } }),
    );
    expect(value.rows.map((r) => r.id).sort()).toEqual(['c-1', 'c-2']);
  });

  it('treats search as a phone prefix LIKE (mirrors phonePrefix)', async () => {
    seedCustomer({ id: 'c-1', name: 'Alice', phone: '555-aa' });
    seedCustomer({ id: 'c-2', name: 'Bob', phone: '999-bb' });

    const value = unwrapOk(await CustomerService.list({ search: '555' }));
    expect(value.rows.map((r) => r.id)).toEqual(['c-1']);
  });

  it('ignores empty / whitespace phonePrefix', async () => {
    seedCustomer({ id: 'c-1', name: 'A', phone: '111' });
    seedCustomer({ id: 'c-2', name: 'B', phone: '222' });

    const value = unwrapOk(
      await CustomerService.list({ filter: { phonePrefix: '   ' } }),
    );
    expect(value.rows).toHaveLength(2);
  });

  it('supports sorting by createdAt DESC', async () => {
    seedCustomer({ id: 'c-1', name: 'A', createdAt: new Date('2024-01-01T00:00:00Z') });
    seedCustomer({ id: 'c-2', name: 'B', createdAt: new Date('2024-03-01T00:00:00Z') });
    seedCustomer({ id: 'c-3', name: 'C', createdAt: new Date('2024-02-01T00:00:00Z') });

    const value = unwrapOk(
      await CustomerService.list({ sort: { key: 'createdAt', dir: 'desc' } }),
    );
    expect(value.rows.map((r) => r.id)).toEqual(['c-2', 'c-3', 'c-1']);
  });

  it('paginates correctly when sorting by createdAt', async () => {
    for (let i = 0; i < 5; i++) {
      seedCustomer({
        id: `c-${i}`,
        name: `N${i}`,
        createdAt: new Date(`2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
      });
    }
    const first = unwrapOk(
      await CustomerService.list({
        sort: { key: 'createdAt', dir: 'desc' },
        pageSize: 2,
      }),
    );
    expect(first.rows.map((r) => r.id)).toEqual(['c-4', 'c-3']);

    const second = unwrapOk(
      await CustomerService.list({
        sort: { key: 'createdAt', dir: 'desc' },
        pageSize: 2,
        cursor: first.nextCursor!,
      }),
    );
    expect(second.rows.map((r) => r.id)).toEqual(['c-2', 'c-1']);
  });

  it('includes totalCount only when withCount is true', async () => {
    for (let i = 0; i < 6; i++) {
      seedCustomer({ name: `Cus ${i}` });
    }
    const without = unwrapOk(await CustomerService.list({ pageSize: 2 }));
    expect('totalCount' in without).toBe(false);

    const withCount = unwrapOk(
      await CustomerService.list({ pageSize: 2, withCount: true }),
    );
    expect(withCount.totalCount).toBe(6);
  });

  it('exposes createdAt as ISO 8601 string in the DTO', async () => {
    seedCustomer({ id: 'c-1', name: 'A', createdAt: new Date('2024-05-01T12:34:56.000Z') });
    const value = unwrapOk(await CustomerService.list({}));
    expect(value.rows[0]!.createdAt).toBe('2024-05-01T12:34:56.000Z');
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe('CustomerService.count', () => {
  it('returns the total count on an empty filter', async () => {
    seedCustomer();
    seedCustomer();
    seedCustomer();
    const result = unwrapOk(await CustomerService.count({}));
    expect(result.totalCount).toBe(3);
  });

  it('respects phonePrefix filter', async () => {
    seedCustomer({ phone: '555-1' });
    seedCustomer({ phone: '555-2' });
    seedCustomer({ phone: '777-9' });
    const result = unwrapOk(
      await CustomerService.count({ filter: { phonePrefix: '555' } }),
    );
    expect(result.totalCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// upsert (create)
// ---------------------------------------------------------------------------

describe('CustomerService.upsert (create)', () => {
  it('creates a customer with all fields populated', async () => {
    const dto = unwrapOk(await CustomerService.upsert(baseInput));
    expect(dto.id).toBe('cus-0');
    expect(dto.name).toBe('Alice Walker');
    expect(dto.phone).toBe('555-1234');
    expect(typeof dto.createdAt).toBe('string');
    expect(mockState.state.customers).toHaveLength(1);
  });

  it('trims surrounding whitespace from name and phone', async () => {
    const dto = unwrapOk(
      await CustomerService.upsert({ name: '  Padded Name  ', phone: '  555  ' }),
    );
    expect(dto.name).toBe('Padded Name');
    expect(dto.phone).toBe('555');
  });

  it('persists null phone when omitted', async () => {
    const dto = unwrapOk(await CustomerService.upsert({ name: 'Bare' }));
    expect(dto.phone).toBeNull();
  });

  it('persists null when caller sends null explicitly', async () => {
    const dto = unwrapOk(
      await CustomerService.upsert({ name: 'Cleared', phone: null }),
    );
    expect(dto.phone).toBeNull();
  });

  it('treats whitespace-only phone as null (clear)', async () => {
    const dto = unwrapOk(
      await CustomerService.upsert({ name: 'Whitespace', phone: '   ' }),
    );
    expect(dto.phone).toBeNull();
  });

  it('rejects whitespace-only name', async () => {
    const result = await CustomerService.upsert({ ...baseInput, name: '    ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'name' });
  });

  it('rejects name longer than 100 chars', async () => {
    const result = await CustomerService.upsert({ ...baseInput, name: 'a'.repeat(101) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'name' });
  });

  it('rejects phone longer than 30 chars', async () => {
    const result = await CustomerService.upsert({ ...baseInput, phone: 'a'.repeat(31) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'phone' });
  });

  it('rejects non-string fields with VALIDATION', async () => {
    const result = await CustomerService.upsert({
      ...baseInput,
      phone: 123 as unknown as string,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'phone' });
  });

  it('allows two customers to share a phone number (no UNIQUE on phone)', async () => {
    const a = unwrapOk(await CustomerService.upsert({ name: 'A', phone: '555' }));
    const b = unwrapOk(await CustomerService.upsert({ name: 'B', phone: '555' }));
    expect(a.id).not.toBe(b.id);
    expect(a.phone).toBe(b.phone);
  });
});

// ---------------------------------------------------------------------------
// upsert (update)
// ---------------------------------------------------------------------------

describe('CustomerService.upsert (update)', () => {
  it('updates an existing customer by id', async () => {
    const id = seedCustomer({ name: 'Old', phone: 'old-phone' });
    const dto = unwrapOk(
      await CustomerService.upsert({ id, name: 'New', phone: 'new-phone' }),
    );
    expect(dto.id).toBe(id);
    expect(dto.name).toBe('New');
    expect(dto.phone).toBe('new-phone');
  });

  it('leaves omitted phone untouched on update', async () => {
    const id = seedCustomer({ name: 'X', phone: 'keep' });
    const dto = unwrapOk(await CustomerService.upsert({ id, name: 'X-Updated' }));
    expect(dto.phone).toBe('keep');
  });

  it('clears phone when caller passes null explicitly', async () => {
    const id = seedCustomer({ name: 'X', phone: 'keep' });
    const dto = unwrapOk(
      await CustomerService.upsert({ id, name: 'X', phone: null }),
    );
    expect(dto.phone).toBeNull();
  });

  it('returns FK_VIOLATION on unknown id (P2025)', async () => {
    const result = await CustomerService.upsert({
      id: 'does-not-exist',
      name: 'Whatever',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });
});

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

describe('CustomerService.detail', () => {
  it('returns the customer and a paginated history page (Req 7.3)', async () => {
    const cashierId = seedUser({ id: 'usr-cash', username: 'cashier1' });
    const id = seedCustomer({ id: 'cus-A', name: 'Alice', phone: '555' });
    seedSale({ id: 's-1', serialNo: 'INV-000001', customerId: id, cashierId, grandTotal: '50.00', createdAt: new Date('2024-01-01T10:00:00Z') });
    seedSale({ id: 's-2', serialNo: 'INV-000002', customerId: id, cashierId, grandTotal: '75.00', createdAt: new Date('2024-02-01T10:00:00Z') });
    // A sale belonging to a different customer — must NOT appear.
    const otherId = seedCustomer({ name: 'Bob' });
    seedSale({ id: 's-other', customerId: otherId, cashierId, grandTotal: '999.00' });
    // A walk-in sale (no customer) — must NOT appear either.
    seedSale({ id: 's-walkin', customerId: null, cashierId, grandTotal: '5.00' });

    const value = unwrapOk(await CustomerService.detail({ id }));
    expect(value.customer.id).toBe(id);
    expect(value.customer.name).toBe('Alice');
    expect(value.history.rows).toHaveLength(2);
    // Newest first (Req 7.3 — descending).
    expect(value.history.rows[0]!.id).toBe('s-2');
    expect(value.history.rows[1]!.id).toBe('s-1');
    expect(value.history.rows[0]!.grandTotal).toBe('75');
    expect(value.history.rows[0]!.customerName).toBe('Alice');
    expect(value.history.rows[0]!.cashierName).toBe('cashier1');
    expect(value.history.rows[0]!.serialNo).toBe('INV-000002');
  });

  it('paginates the history by cursor', async () => {
    const cashierId = seedUser();
    const id = seedCustomer({ name: 'Alice' });
    for (let i = 0; i < 5; i++) {
      seedSale({
        id: `s-${i}`,
        customerId: id,
        cashierId,
        createdAt: new Date(`2024-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
      });
    }

    const first = unwrapOk(
      await CustomerService.detail({ id, history: { pageSize: 2 } }),
    );
    expect(first.history.rows).toHaveLength(2);
    expect(first.history.nextCursor).not.toBeNull();

    const second = unwrapOk(
      await CustomerService.detail({
        id,
        history: { pageSize: 2, cursor: first.history.nextCursor! },
      }),
    );
    expect(second.history.rows).toHaveLength(2);
    // Pages must not overlap.
    const firstIds = first.history.rows.map((r) => r.id);
    const secondIds = second.history.rows.map((r) => r.id);
    expect(firstIds.some((x) => secondIds.includes(x))).toBe(false);

    const third = unwrapOk(
      await CustomerService.detail({
        id,
        history: { pageSize: 2, cursor: second.history.nextCursor! },
      }),
    );
    expect(third.history.rows).toHaveLength(1);
    expect(third.history.nextCursor).toBeNull();
  });

  it('includes totalCount on the history page when withCount is true', async () => {
    const cashierId = seedUser();
    const id = seedCustomer({ name: 'Alice' });
    for (let i = 0; i < 3; i++) {
      seedSale({ id: `s-${i}`, customerId: id, cashierId });
    }
    const value = unwrapOk(
      await CustomerService.detail({ id, history: { pageSize: 1, withCount: true } }),
    );
    expect(value.history.totalCount).toBe(3);
  });

  it('returns FK_VIOLATION on unknown customer id', async () => {
    const result = await CustomerService.detail({ id: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });

  it('returns VALIDATION on empty id', async () => {
    const result = await CustomerService.detail({ id: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'id' });
    }
  });

  it('returns an empty history when the customer has no sales', async () => {
    const id = seedCustomer({ name: 'Solo' });
    const value = unwrapOk(await CustomerService.detail({ id }));
    expect(value.history.rows).toEqual([]);
    expect(value.history.nextCursor).toBeNull();
  });
});
