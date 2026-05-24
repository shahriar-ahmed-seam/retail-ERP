import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `SupplierService` (Phase 6, task 6.1).
 *
 * Drives the service against an in-memory mock of the Prisma
 * delegates (`supplier.findMany`, `supplier.findUnique`,
 * `supplier.create`, `supplier.update`, `supplier.count`,
 * `purchase.findMany`, `purchase.count`). The mock mimics:
 *
 *   - cuid-style id generation on create,
 *   - the absence of UNIQUE constraints on `Supplier` (no P2002
 *     mapping is required for this service; the schema only has
 *     `@@index([name])`),
 *   - Prisma's `P2025` shape for missing-record errors on update,
 *   - the `Supplier ←→ Purchase` join used by `detail`.
 *
 * Validates: Requirements 6.1, 6.2, 6.3.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockSupplier {
    id: string;
    name: string;
    phone: string | null;
    address: string | null;
  }
  interface MockPurchase {
    id: string;
    supplierId: string;
    invoiceNo: string | null;
    total: string;
    createdAt: Date;
    itemCount: number;
  }

  const state = {
    suppliers: [] as MockSupplier[],
    purchases: [] as MockPurchase[],
    nextSupplierId: 0,
  };

  return {
    state,
    reset(): void {
      state.suppliers = [];
      state.purchases = [];
      state.nextSupplierId = 0;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  type MockSupplier = (typeof state.suppliers)[number];
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
        if ((av as never) < (bv as never)) return dir === 'asc' ? -1 : 1;
        if ((av as never) > (bv as never)) return dir === 'asc' ? 1 : -1;
      }
    }
    return 0;
  }

  // ---- Supplier delegate ------------------------------------------------
  function supplierFindMany({
    where,
    orderBy,
    take,
  }: {
    where?: Record<string, unknown>;
    orderBy?: readonly Record<string, 'asc' | 'desc'>[];
    take?: number;
  }): Promise<MockSupplier[]> {
    let rows = state.suppliers.filter((r) => matches(r as Record<string, unknown>, where));
    if (orderBy && orderBy.length > 0) {
      rows = [...rows].sort((a, b) =>
        compareRows(a as Record<string, unknown>, b as Record<string, unknown>, orderBy),
      );
    }
    if (typeof take === 'number') rows = rows.slice(0, take);
    return Promise.resolve(rows.map((r) => ({ ...r })));
  }

  function supplierFindUnique({
    where,
  }: {
    where: { id?: string };
  }): Promise<MockSupplier | null> {
    const row = state.suppliers.find((r) => where.id !== undefined && r.id === where.id);
    return Promise.resolve(row ? { ...row } : null);
  }

  function supplierCreate({
    data,
  }: {
    data: { name: string; phone?: string | null; address?: string | null };
  }): Promise<MockSupplier> {
    const row: MockSupplier = {
      id: `sup-${state.nextSupplierId++}`,
      name: data.name,
      phone: data.phone ?? null,
      address: data.address ?? null,
    };
    state.suppliers.push(row);
    return Promise.resolve({ ...row });
  }

  function supplierUpdate({
    where,
    data,
  }: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<MockSupplier> {
    const row = state.suppliers.find((r) => r.id === where.id);
    if (!row) {
      throw makeRecordNotFound();
    }
    for (const [k, v] of Object.entries(data)) {
      (row as unknown as Record<string, unknown>)[k] = v;
    }
    return Promise.resolve({ ...row });
  }

  function supplierCount({
    where,
  }: {
    where?: Record<string, unknown>;
  }): Promise<number> {
    return Promise.resolve(
      state.suppliers.filter((r) => matches(r as Record<string, unknown>, where)).length,
    );
  }

  // ---- Purchase delegate ------------------------------------------------
  function purchaseFindMany({
    where,
    orderBy,
    take,
    include,
  }: {
    where?: Record<string, unknown>;
    orderBy?: readonly Record<string, 'asc' | 'desc'>[];
    take?: number;
    include?: { supplier?: unknown; _count?: unknown };
  }): Promise<unknown[]> {
    let rows = state.purchases.filter((r) =>
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
          supplierId: r.supplierId,
          invoiceNo: r.invoiceNo,
          total: new Prisma.Decimal(r.total),
          createdAt: r.createdAt,
        };
        if (include?.supplier !== undefined) {
          const s = state.suppliers.find((sup) => sup.id === r.supplierId);
          out.supplier = s ? { name: s.name } : { name: 'Unknown' };
        }
        if (include?._count !== undefined) {
          out._count = { items: r.itemCount };
        }
        return out;
      }),
    );
  }

  function purchaseCount({
    where,
  }: {
    where?: Record<string, unknown>;
  }): Promise<number> {
    return Promise.resolve(
      state.purchases.filter((r) => matches(r as Record<string, unknown>, where)).length,
    );
  }

  return {
    prisma: {
      supplier: {
        findMany: supplierFindMany,
        findUnique: supplierFindUnique,
        create: supplierCreate,
        update: supplierUpdate,
        count: supplierCount,
      },
      purchase: {
        findMany: purchaseFindMany,
        count: purchaseCount,
      },
    },
  };
});

// Imports MUST come after `vi.mock`.
import { SupplierService } from '@main/services/supplier.service';

import type { SupplierInput } from '@shared/dto/index';

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

function seedSupplier(overrides: Partial<{
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
}> = {}): string {
  const id = overrides.id ?? `sup-seed-${mockState.state.suppliers.length}`;
  mockState.state.suppliers.push({
    id,
    name: overrides.name ?? `Name ${id}`,
    phone: overrides.phone ?? null,
    address: overrides.address ?? null,
  });
  return id;
}

function seedPurchase(overrides: Partial<{
  id: string;
  supplierId: string;
  invoiceNo: string | null;
  total: string;
  createdAt: Date;
  itemCount: number;
}> = {}): string {
  const id = overrides.id ?? `pur-${mockState.state.purchases.length}`;
  mockState.state.purchases.push({
    id,
    supplierId: overrides.supplierId ?? 'sup-0',
    invoiceNo: overrides.invoiceNo ?? null,
    total: overrides.total ?? '100.00',
    createdAt: overrides.createdAt ?? new Date(`2024-01-${String(mockState.state.purchases.length + 1).padStart(2, '0')}T10:00:00Z`),
    itemCount: overrides.itemCount ?? 1,
  });
  return id;
}

const baseInput: SupplierInput = {
  name: 'Acme Corp',
  phone: '555-1234',
  address: '1 Main St',
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

describe('SupplierService.list', () => {
  it('returns an empty page on an empty table', async () => {
    const result = await SupplierService.list({});
    const value = unwrapOk(result);
    expect(value.rows).toEqual([]);
    expect(value.nextCursor).toBeNull();
    expect('totalCount' in value).toBe(false);
  });

  it('orders by (name ASC, id ASC) by default (Req 6.2)', async () => {
    seedSupplier({ id: 'a', name: 'Zenith' });
    seedSupplier({ id: 'b', name: 'Acme' });
    seedSupplier({ id: 'c', name: 'Mango' });

    const value = unwrapOk(await SupplierService.list({}));
    expect(value.rows.map((r) => r.name)).toEqual(['Acme', 'Mango', 'Zenith']);
  });

  it('clamps pageSize to [1, 200]', async () => {
    for (let i = 0; i < 5; i++) {
      seedSupplier({ name: `Sup ${i}` });
    }
    const result = unwrapOk(
      await SupplierService.list({ pageSize: 1_000_000 }),
    );
    expect(result.rows).toHaveLength(5);
  });

  it('paginates by cursor and the walk completes when fewer than pageSize rows return', async () => {
    for (let i = 0; i < 7; i++) {
      seedSupplier({ id: `s-${i}`, name: `Name ${String(i).padStart(2, '0')}` });
    }
    const first = unwrapOk(await SupplierService.list({ pageSize: 3 }));
    expect(first.rows).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows.map((r) => r.name)).toEqual(['Name 00', 'Name 01', 'Name 02']);

    const second = unwrapOk(
      await SupplierService.list({ pageSize: 3, cursor: first.nextCursor! }),
    );
    expect(second.rows.map((r) => r.name)).toEqual(['Name 03', 'Name 04', 'Name 05']);

    const third = unwrapOk(
      await SupplierService.list({ pageSize: 3, cursor: second.nextCursor! }),
    );
    expect(third.rows.map((r) => r.name)).toEqual(['Name 06']);
    expect(third.nextCursor).toBeNull();
  });

  it('returns Err(VALIDATION, { field: "cursor" }) on malformed cursor', async () => {
    seedSupplier();
    const result = await SupplierService.list({ cursor: 'not-base64!!!' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'cursor' });
    }
  });

  it('searches by case-insensitive prefix on name', async () => {
    seedSupplier({ id: 's-1', name: 'Acme Tools' });
    seedSupplier({ id: 's-2', name: 'acme parts' });
    seedSupplier({ id: 's-3', name: 'Zenith' });

    const value = unwrapOk(await SupplierService.list({ search: 'acme' }));
    expect(value.rows.map((r) => r.id).sort()).toEqual(['s-1', 's-2']);
  });

  it('includes totalCount only when withCount is true', async () => {
    for (let i = 0; i < 6; i++) {
      seedSupplier({ name: `Sup ${i}` });
    }
    const without = unwrapOk(await SupplierService.list({ pageSize: 2 }));
    expect('totalCount' in without).toBe(false);

    const withCount = unwrapOk(
      await SupplierService.list({ pageSize: 2, withCount: true }),
    );
    expect(withCount.totalCount).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe('SupplierService.count', () => {
  it('returns the total count of all suppliers on an empty filter', async () => {
    seedSupplier();
    seedSupplier();
    seedSupplier();
    const result = unwrapOk(await SupplierService.count({}));
    expect(result.totalCount).toBe(3);
  });

  it('respects search prefix', async () => {
    seedSupplier({ name: 'Acme Tools' });
    seedSupplier({ name: 'Acme Parts' });
    seedSupplier({ name: 'Zenith' });
    const result = unwrapOk(await SupplierService.count({ search: 'acme' }));
    expect(result.totalCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// upsert (create)
// ---------------------------------------------------------------------------

describe('SupplierService.upsert (create)', () => {
  it('creates a supplier with all fields populated', async () => {
    const dto = unwrapOk(await SupplierService.upsert(baseInput));
    expect(dto.id).toBe('sup-0');
    expect(dto.name).toBe('Acme Corp');
    expect(dto.phone).toBe('555-1234');
    expect(dto.address).toBe('1 Main St');
    expect(mockState.state.suppliers).toHaveLength(1);
  });

  it('trims surrounding whitespace from name, phone, address', async () => {
    const dto = unwrapOk(
      await SupplierService.upsert({
        name: '  Padded Name  ',
        phone: '  555  ',
        address: '  Lane  ',
      }),
    );
    expect(dto.name).toBe('Padded Name');
    expect(dto.phone).toBe('555');
    expect(dto.address).toBe('Lane');
  });

  it('persists null phone and address when omitted', async () => {
    const dto = unwrapOk(await SupplierService.upsert({ name: 'Bare' }));
    expect(dto.phone).toBeNull();
    expect(dto.address).toBeNull();
  });

  it('persists null when caller sends null explicitly', async () => {
    const dto = unwrapOk(
      await SupplierService.upsert({ name: 'Cleared', phone: null, address: null }),
    );
    expect(dto.phone).toBeNull();
    expect(dto.address).toBeNull();
  });

  it('treats whitespace-only optional inputs as null (clear)', async () => {
    const dto = unwrapOk(
      await SupplierService.upsert({ name: 'Whitespace', phone: '   ', address: '   ' }),
    );
    expect(dto.phone).toBeNull();
    expect(dto.address).toBeNull();
  });

  it('rejects whitespace-only name', async () => {
    const result = await SupplierService.upsert({ ...baseInput, name: '    ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'name' });
  });

  it('rejects name longer than 100 chars', async () => {
    const result = await SupplierService.upsert({ ...baseInput, name: 'a'.repeat(101) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'name' });
  });

  it('rejects phone longer than 30 chars', async () => {
    const result = await SupplierService.upsert({ ...baseInput, phone: 'a'.repeat(31) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'phone' });
  });

  it('rejects address longer than 200 chars', async () => {
    const result = await SupplierService.upsert({ ...baseInput, address: 'a'.repeat(201) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'address' });
  });

  it('rejects non-string fields with VALIDATION', async () => {
    const result = await SupplierService.upsert({
      ...baseInput,
      phone: 123 as unknown as string,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'phone' });
  });
});

// ---------------------------------------------------------------------------
// upsert (update)
// ---------------------------------------------------------------------------

describe('SupplierService.upsert (update)', () => {
  it('updates an existing supplier by id', async () => {
    const id = seedSupplier({ name: 'Old', phone: 'old-phone' });
    const dto = unwrapOk(
      await SupplierService.upsert({ id, name: 'New', phone: 'new-phone' }),
    );
    expect(dto.id).toBe(id);
    expect(dto.name).toBe('New');
    expect(dto.phone).toBe('new-phone');
  });

  it('leaves omitted optional fields untouched on update', async () => {
    const id = seedSupplier({ name: 'X', phone: 'keep', address: 'keep-addr' });
    const dto = unwrapOk(
      await SupplierService.upsert({ id, name: 'X-Updated' }),
    );
    expect(dto.phone).toBe('keep');
    expect(dto.address).toBe('keep-addr');
  });

  it('clears optional fields when caller passes null explicitly', async () => {
    const id = seedSupplier({ name: 'X', phone: 'keep', address: 'keep' });
    const dto = unwrapOk(
      await SupplierService.upsert({ id, name: 'X', phone: null, address: null }),
    );
    expect(dto.phone).toBeNull();
    expect(dto.address).toBeNull();
  });

  it('returns FK_VIOLATION on unknown id (P2025)', async () => {
    const result = await SupplierService.upsert({
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

describe('SupplierService.detail', () => {
  it('returns the supplier and a paginated history page (Req 6.3)', async () => {
    const id = seedSupplier({ name: 'Acme', phone: '5', address: 'Lane' });
    seedPurchase({ id: 'p-1', supplierId: id, invoiceNo: 'INV-1', total: '50.00', createdAt: new Date('2024-01-01T10:00:00Z'), itemCount: 2 });
    seedPurchase({ id: 'p-2', supplierId: id, invoiceNo: 'INV-2', total: '75.00', createdAt: new Date('2024-02-01T10:00:00Z'), itemCount: 3 });
    // A purchase from a different supplier — must NOT appear.
    const otherId = seedSupplier({ name: 'Other' });
    seedPurchase({ id: 'p-other', supplierId: otherId, invoiceNo: 'X', total: '999.00' });

    const value = unwrapOk(await SupplierService.detail({ id }));
    expect(value.supplier.id).toBe(id);
    expect(value.supplier.name).toBe('Acme');
    expect(value.history.rows).toHaveLength(2);
    // Newest first.
    expect(value.history.rows[0]!.id).toBe('p-2');
    expect(value.history.rows[1]!.id).toBe('p-1');
    expect(value.history.rows[0]!.itemCount).toBe(3);
    expect(value.history.rows[0]!.total).toBe('75');
    expect(value.history.rows[0]!.supplierName).toBe('Acme');
  });

  it('paginates the history by cursor', async () => {
    const id = seedSupplier({ name: 'Acme' });
    for (let i = 0; i < 5; i++) {
      seedPurchase({
        id: `p-${i}`,
        supplierId: id,
        createdAt: new Date(`2024-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
      });
    }

    const first = unwrapOk(
      await SupplierService.detail({ id, history: { pageSize: 2 } }),
    );
    expect(first.history.rows).toHaveLength(2);
    expect(first.history.nextCursor).not.toBeNull();

    const second = unwrapOk(
      await SupplierService.detail({
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
      await SupplierService.detail({
        id,
        history: { pageSize: 2, cursor: second.history.nextCursor! },
      }),
    );
    expect(third.history.rows).toHaveLength(1);
    expect(third.history.nextCursor).toBeNull();
  });

  it('includes totalCount on the history page when withCount is true', async () => {
    const id = seedSupplier({ name: 'Acme' });
    for (let i = 0; i < 3; i++) {
      seedPurchase({ id: `p-${i}`, supplierId: id });
    }
    const value = unwrapOk(
      await SupplierService.detail({ id, history: { pageSize: 1, withCount: true } }),
    );
    expect(value.history.totalCount).toBe(3);
  });

  it('returns FK_VIOLATION on unknown supplier id', async () => {
    const result = await SupplierService.detail({ id: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });

  it('returns VALIDATION on empty id', async () => {
    const result = await SupplierService.detail({ id: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'id' });
    }
  });

  it('returns an empty history when the supplier has no purchases', async () => {
    const id = seedSupplier({ name: 'Solo' });
    const value = unwrapOk(await SupplierService.detail({ id }));
    expect(value.history.rows).toEqual([]);
    expect(value.history.nextCursor).toBeNull();
  });
});
