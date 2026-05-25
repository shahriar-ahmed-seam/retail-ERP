import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `ProductService` (Phase 4, task 4.2).
 *
 * Drives the service against an in-memory mock of the Prisma delegates
 * (`product.findMany`, `product.findUnique`, `product.create`,
 * `product.update`, `product.count`, `inventory.create`, plus
 * `$transaction` and `$queryRaw`). The mock mimics:
 *
 *   - cuid-style id generation on create,
 *   - the unique constraints on `Product.sku` and `Product.barcode`,
 *   - the FK constraint on `Product.categoryId`,
 *   - the joined `Inventory.onHand` relation,
 *   - Prisma's `P2002` shape for unique violations,
 *   - Prisma's `P2025` shape for missing-record errors,
 *   - Prisma's `P2003` shape for FK violations,
 *   - the cross-column `lowStockOnly` query (run via `$queryRaw`).
 *
 * The `Prisma.PrismaClientKnownRequestError` and `Prisma.Decimal`
 * symbols are sourced from the actual `@prisma/client` package so the
 * service's `instanceof` checks and decimal validation exercise the
 * same code paths as production.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 7 (read-only access).
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockProduct {
    id: string;
    sku: string;
    name: string;
    categoryId: string;
    barcode: string | null;
    buyPrice: string;
    sellPrice: string;
    taxRate: string;
    warrantyMonths: number;
    reorderLevel: number;
  }
  interface MockInventory {
    productId: string;
    onHand: number;
    updatedAt: Date;
  }
  interface MockCategory {
    id: string;
    name: string;
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
    products: [] as MockProduct[],
    inventories: [] as MockInventory[],
    categories: [] as MockCategory[],
    auditLogs: [] as MockAuditLog[],
    journalEntries: [] as MockJournalEntry[],
    nextProductId: 0,
    nextAuditId: 0,
    nextJournalId: 0,
  };

  return {
    state,
    reset(): void {
      state.products = [];
      state.inventories = [];
      state.categories = [];
      state.auditLogs = [];
      state.journalEntries = [];
      state.nextProductId = 0;
      state.nextAuditId = 0;
      state.nextJournalId = 0;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  type MockProduct = (typeof state.products)[number];
  type MockInventory = (typeof state.inventories)[number];
  type Op = 'lt' | 'lte' | 'gt' | 'gte' | 'equals' | 'in' | 'startsWith';

  function makeUniqueViolation(target: string[]): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      `Unique constraint failed on the fields: (\`${target.join(',')}\`)`,
      { code: 'P2002', clientVersion: 'test', meta: { target } },
    );
  }

  function makeRecordNotFound(): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      'An operation failed because it depends on one or more records that were required but not found.',
      { code: 'P2025', clientVersion: 'test' },
    );
  }

  function makeFkViolation(field: string): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      `Foreign key constraint failed on the field: \`${field}\``,
      { code: 'P2003', clientVersion: 'test', meta: { field_name: field } },
    );
  }

  /**
   * Apply a Prisma-style `WhereInput` predicate to a row. Supports the
   * narrow subset the product service emits: top-level `AND`/`OR`,
   * scalar equality, comparator objects (`{ lt|gt|... }`), `in: [...]`,
   * `startsWith`.
   */
  function matches(row: MockProduct, where: Record<string, unknown> | undefined): boolean {
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

      const fieldValue = (row as unknown as Record<string, unknown>)[key];
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

  function compareRows(a: MockProduct, b: MockProduct, orderBy: readonly Record<string, 'asc' | 'desc'>[]): number {
    for (const clause of orderBy) {
      for (const [key, dir] of Object.entries(clause)) {
        const av = (a as unknown as Record<string, unknown>)[key];
        const bv = (b as unknown as Record<string, unknown>)[key];
        if ((av as never) < (bv as never)) return dir === 'asc' ? -1 : 1;
        if ((av as never) > (bv as never)) return dir === 'asc' ? 1 : -1;
      }
    }
    return 0;
  }

  function attachJoins(
    row: MockProduct,
    include?: { inventory?: boolean; category?: { select?: { name?: boolean } } | boolean },
  ): unknown {
    const inv = state.inventories.find((i) => i.productId === row.id) ?? null;
    const cat = state.categories.find((c) => c.id === row.categoryId) ?? null;
    const out: {
      id: string;
      sku: string;
      name: string;
      categoryId: string;
      barcode: string | null;
      buyPrice: import('@prisma/client').Prisma.Decimal;
      sellPrice: import('@prisma/client').Prisma.Decimal;
      taxRate: import('@prisma/client').Prisma.Decimal;
      warrantyMonths: number;
      reorderLevel: number;
      inventory?: MockInventory | null;
      category?: { name: string } | null;
    } = {
      id: row.id,
      sku: row.sku,
      name: row.name,
      categoryId: row.categoryId,
      barcode: row.barcode,
      buyPrice: new Prisma.Decimal(row.buyPrice),
      sellPrice: new Prisma.Decimal(row.sellPrice),
      taxRate: new Prisma.Decimal(row.taxRate),
      warrantyMonths: row.warrantyMonths,
      reorderLevel: row.reorderLevel,
    };
    if (include?.inventory === true) {
      out.inventory = inv;
    }
    if (include?.category) {
      out.category = cat ? { name: cat.name } : null;
    }
    return out;
  }

  function findManyImpl({
    where,
    orderBy,
    take,
    include,
  }: {
    where?: Record<string, unknown>;
    orderBy?: readonly Record<string, 'asc' | 'desc'>[];
    take?: number;
    include?: { inventory?: boolean; category?: { select?: { name?: boolean } } | boolean };
  }): Promise<unknown[]> {
    let rows = state.products.filter((r) => matches(r, where));
    if (orderBy && orderBy.length > 0) {
      rows = [...rows].sort((a, b) => compareRows(a, b, orderBy));
    }
    if (typeof take === 'number') rows = rows.slice(0, take);
    return Promise.resolve(rows.map((r) => attachJoins(r, include)));
  }

  function findUniqueImpl({
    where,
    include,
    select,
  }: {
    where: { id?: string; barcode?: string; sku?: string };
    include?: { inventory?: boolean; category?: { select?: { name?: boolean } } | boolean };
    select?: { buyPrice?: boolean; sellPrice?: boolean };
  }): Promise<unknown> {
    const row = state.products.find(
      (r) =>
        (where.id !== undefined && r.id === where.id) ||
        (where.barcode !== undefined && r.barcode === where.barcode) ||
        (where.sku !== undefined && r.sku === where.sku),
    );
    if (!row) return Promise.resolve(null);
    // `select` projects a subset of decimal-typed columns. The
    // service uses this on the price-change audit path to read the
    // persisted prices without hydrating the full row.
    if (select !== undefined) {
      const out: Record<string, unknown> = {};
      if (select.buyPrice === true) out.buyPrice = new Prisma.Decimal(row.buyPrice);
      if (select.sellPrice === true) out.sellPrice = new Prisma.Decimal(row.sellPrice);
      return Promise.resolve(out);
    }
    return Promise.resolve(attachJoins(row, include));
  }

  function createImpl({
    data,
    include,
  }: {
    data: {
      sku: string;
      name: string;
      categoryId: string;
      barcode?: string | null;
      buyPrice: { toString: () => string };
      sellPrice: { toString: () => string };
      taxRate: { toString: () => string };
      warrantyMonths: number;
      reorderLevel: number;
    };
    include?: { inventory?: boolean; category?: { select?: { name?: boolean } } | boolean };
  }): Promise<unknown> {
    if (!state.categories.some((c) => c.id === data.categoryId)) {
      throw makeFkViolation('Product_categoryId_fkey');
    }
    if (state.products.some((p) => p.sku === data.sku)) {
      throw makeUniqueViolation(['sku']);
    }
    if (data.barcode !== null && data.barcode !== undefined && state.products.some((p) => p.barcode === data.barcode)) {
      throw makeUniqueViolation(['barcode']);
    }
    const row: MockProduct = {
      id: `prod-${state.nextProductId++}`,
      sku: data.sku,
      name: data.name,
      categoryId: data.categoryId,
      barcode: data.barcode ?? null,
      buyPrice: data.buyPrice.toString(),
      sellPrice: data.sellPrice.toString(),
      taxRate: data.taxRate.toString(),
      warrantyMonths: data.warrantyMonths,
      reorderLevel: data.reorderLevel,
    };
    state.products.push(row);
    return Promise.resolve(attachJoins(row, include));
  }

  function updateImpl({
    where,
    data,
    include,
  }: {
    where: { id: string };
    data: Record<string, unknown>;
    include?: { inventory?: boolean; category?: { select?: { name?: boolean } } | boolean };
  }): Promise<unknown> {
    const row = state.products.find((r) => r.id === where.id);
    if (!row) {
      throw makeRecordNotFound();
    }
    // Resolve nested category connect into a flat categoryId string so
    // the rest of the mock's compare/where logic stays simple.
    const flat: Record<string, unknown> = { ...data };
    const nestedCategory = flat.category;
    if (nestedCategory != null && typeof nestedCategory === 'object') {
      const c = nestedCategory as { connect?: { id?: string } };
      if (c.connect?.id !== undefined) {
        flat.categoryId = c.connect.id;
      }
      delete flat.category;
    }
    const newCategoryId = flat.categoryId;
    if (typeof newCategoryId === 'string' && !state.categories.some((c) => c.id === newCategoryId)) {
      throw makeFkViolation('Product_categoryId_fkey');
    }
    const newSku = flat.sku;
    if (typeof newSku === 'string') {
      if (state.products.some((p) => p.id !== row.id && p.sku === newSku)) {
        throw makeUniqueViolation(['sku']);
      }
    }
    const newBarcode = flat.barcode;
    if (typeof newBarcode === 'string' || newBarcode === null) {
      const target = newBarcode;
      if (target !== null && state.products.some((p) => p.id !== row.id && p.barcode === target)) {
        throw makeUniqueViolation(['barcode']);
      }
    }
    for (const [k, v] of Object.entries(flat)) {
      const isDecimal = ['buyPrice', 'sellPrice', 'taxRate'].includes(k);
      if (isDecimal && v !== null && typeof v === 'object') {
        (row as unknown as Record<string, unknown>)[k] = (v as { toString: () => string }).toString();
        continue;
      }
      (row as unknown as Record<string, unknown>)[k] = v;
    }
    return Promise.resolve(attachJoins(row, include));
  }

  function countImpl({ where }: { where?: Record<string, unknown> }): Promise<number> {
    return Promise.resolve(state.products.filter((r) => matches(r, where)).length);
  }

  function inventoryCreateImpl({ data }: { data: { productId: string; onHand: number } }): Promise<unknown> {
    const row: MockInventory = {
      productId: data.productId,
      onHand: data.onHand,
      updatedAt: new Date(),
    };
    state.inventories.push(row);
    return Promise.resolve({ ...row });
  }

  function auditLogCreateImpl({
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
  }): Promise<unknown> {
    const row = {
      id: `audit-${state.nextAuditId++}`,
      actionType: data.actionType,
      entityType: data.entityType,
      entityId: data.entityId,
      previous: data.previous ?? null,
      next: data.next ?? null,
      userId: data.userId ?? null,
      timestamp: new Date(),
    };
    state.auditLogs.push(row);
    return Promise.resolve({ ...row });
  }

  // Mirrors `prisma.journalEntry.create` for the price-change branch
  // (task 11.4 — every business `$transaction` ends with one
  // `journal_entries` insert). Mutations live in-memory alongside the
  // audit log so the tx snapshot/rollback covers both append-only
  // tables uniformly.
  function journalEntryCreateImpl({
    data,
  }: {
    data: { opType: string; payload: string };
  }): Promise<unknown> {
    const row = {
      id: `journal-${state.nextJournalId++}`,
      opType: data.opType,
      payload: data.payload,
      timestamp: new Date(),
    };
    state.journalEntries.push(row);
    return Promise.resolve({ ...row });
  }

  // The product service uses Prisma.sql for $queryRaw. The template
  // function returns an opaque object; our mock ignores it entirely
  // and computes the low-stock set against the mock inventories +
  // products instead.
  function queryRawImpl(): Promise<{ productId: string }[]> {
    const ids: { productId: string }[] = [];
    for (const inv of state.inventories) {
      const prod = state.products.find((p) => p.id === inv.productId);
      if (!prod) continue;
      if (inv.onHand <= prod.reorderLevel) {
        ids.push({ productId: inv.productId });
      }
    }
    return Promise.resolve(ids);
  }

  // Transaction handle exposed to `$transaction` callbacks. The
  // surface mirrors what the service touches inside its
  // `$transaction` blocks: `product.create` + `inventory.create` for
  // create-path atomicity, and `product.update` + `auditLog.create` +
  // `journalEntry.create` for the price-change audit + journal path
  // (tasks 4.3 + 11.4). Mutations applied through the tx hit the
  // same in-memory state so a successful commit is observable; this
  // mock does not roll back on throw, but the service's error
  // mapping is exercised independently in the surrounding tests.
  const tx = {
    product: { create: createImpl, update: updateImpl, findUnique: findUniqueImpl },
    inventory: { create: inventoryCreateImpl },
    auditLog: { create: auditLogCreateImpl },
    journalEntry: { create: journalEntryCreateImpl },
  };

  async function $transaction<T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> {
    // Snapshot mutable state so an in-tx throw rolls everything back —
    // matching Prisma's real `$transaction` semantics. The product
    // service's price-change audit + journal path relies on this: a
    // failed `tx.product.update` MUST take both the in-tx
    // `tx.auditLog.create` AND the `tx.journalEntry.create` rows
    // down with it.
    const snapshot = {
      products: state.products.map((p) => ({ ...p })),
      inventories: state.inventories.map((i) => ({ ...i })),
      auditLogs: state.auditLogs.map((a) => ({ ...a })),
      journalEntries: state.journalEntries.map((j) => ({ ...j })),
      nextProductId: state.nextProductId,
      nextAuditId: state.nextAuditId,
      nextJournalId: state.nextJournalId,
    };
    try {
      return await cb(tx);
    } catch (err) {
      state.products = snapshot.products;
      state.inventories = snapshot.inventories;
      state.auditLogs = snapshot.auditLogs;
      state.journalEntries = snapshot.journalEntries;
      state.nextProductId = snapshot.nextProductId;
      state.nextAuditId = snapshot.nextAuditId;
      state.nextJournalId = snapshot.nextJournalId;
      throw err;
    }
  }

  return {
    prisma: {
      product: {
        findMany: findManyImpl,
        findUnique: findUniqueImpl,
        create: createImpl,
        update: updateImpl,
        count: countImpl,
      },
      inventory: {
        create: inventoryCreateImpl,
      },
      auditLog: {
        create: auditLogCreateImpl,
      },
      $transaction,
      $queryRaw: queryRawImpl,
    },
  };
});

// Imports MUST come after `vi.mock`.
import { ProductService } from '@main/services/product.service';

import type { ProductInput } from '@shared/dto/index';

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

function seedCategory(id: string, name: string): void {
  mockState.state.categories.push({ id, name });
}

function seedProduct(overrides: Partial<{ id: string; sku: string; name: string; categoryId: string; barcode: string | null; buyPrice: string; sellPrice: string; taxRate: string; warrantyMonths: number; reorderLevel: number; onHand: number; }> = {}): string {
  const id = overrides.id ?? `prod-seed-${mockState.state.products.length}`;
  mockState.state.products.push({
    id,
    sku: overrides.sku ?? `SKU-${id}`,
    name: overrides.name ?? `Name ${id}`,
    categoryId: overrides.categoryId ?? 'cat-default',
    barcode: overrides.barcode ?? null,
    buyPrice: overrides.buyPrice ?? '10',
    sellPrice: overrides.sellPrice ?? '15',
    taxRate: overrides.taxRate ?? '0',
    warrantyMonths: overrides.warrantyMonths ?? 0,
    reorderLevel: overrides.reorderLevel ?? 0,
  });
  mockState.state.inventories.push({
    productId: id,
    onHand: overrides.onHand ?? 0,
    updatedAt: new Date(),
  });
  return id;
}

const baseInput: ProductInput = {
  sku: 'SKU-1',
  name: 'Hammer 16oz',
  categoryId: 'cat-1',
  buyPrice: '10.00',
  sellPrice: '15.00',
  taxRate: '0.18',
  warrantyMonths: 0,
  reorderLevel: 5,
};

beforeEach(() => {
  mockState.reset();
  seedCategory('cat-1', 'Hardware');
  seedCategory('cat-2', 'Lighting');
});

afterEach(() => {
  mockState.reset();
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('ProductService.list', () => {
  it('returns an empty page on an empty table', async () => {
    const result = await ProductService.list({});
    const value = unwrapOk(result);
    expect(value.rows).toEqual([]);
    expect(value.nextCursor).toBeNull();
    expect('totalCount' in value).toBe(false);
  });

  it('clamps pageSize to [1, 200] and projects onHand from the inventory join', async () => {
    for (let i = 0; i < 5; i++) {
      seedProduct({ name: `Prod ${i}`, sku: `SKU-${i}`, onHand: i + 1 });
    }
    const result = await ProductService.list({ pageSize: 1_000_000, sort: { key: 'name', dir: 'asc' } });
    const value = unwrapOk(result);
    expect(value.rows).toHaveLength(5);
    expect(value.rows.every((r) => typeof r.onHand === 'number')).toBe(true);
    expect(value.rows.map((r) => r.onHand).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('paginates by cursor and the walk completes when fewer than pageSize rows return', async () => {
    for (let i = 0; i < 7; i++) {
      seedProduct({ id: `p-${i}`, name: `Item ${String(i).padStart(2, '0')}`, sku: `S${i}` });
    }
    const first = unwrapOk(
      await ProductService.list({ pageSize: 3, sort: { key: 'name', dir: 'asc' } }),
    );
    expect(first.rows).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows.map((r) => r.name)).toEqual(['Item 00', 'Item 01', 'Item 02']);

    const second = unwrapOk(
      await ProductService.list({
        pageSize: 3,
        sort: { key: 'name', dir: 'asc' },
        cursor: first.nextCursor!,
      }),
    );
    expect(second.rows.map((r) => r.name)).toEqual(['Item 03', 'Item 04', 'Item 05']);

    const third = unwrapOk(
      await ProductService.list({
        pageSize: 3,
        sort: { key: 'name', dir: 'asc' },
        cursor: second.nextCursor!,
      }),
    );
    expect(third.rows.map((r) => r.name)).toEqual(['Item 06']);
    expect(third.nextCursor).toBeNull();
  });

  it('returns Err(VALIDATION, { field: "cursor" }) on malformed cursor', async () => {
    seedProduct();
    const result = await ProductService.list({ cursor: 'not-base64!!!' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'cursor' });
    }
  });

  it('filters by categoryId', async () => {
    seedProduct({ id: 'p-a', categoryId: 'cat-1', name: 'Hammer' });
    seedProduct({ id: 'p-b', categoryId: 'cat-2', name: 'Lamp' });
    seedProduct({ id: 'p-c', categoryId: 'cat-1', name: 'Saw' });

    const result = unwrapOk(
      await ProductService.list({ filter: { categoryId: 'cat-1' }, sort: { key: 'name', dir: 'asc' } }),
    );
    expect(result.rows.map((r) => r.id).sort()).toEqual(['p-a', 'p-c']);
  });

  it('filters by lowStockOnly using the cross-column predicate', async () => {
    seedProduct({ id: 'p-low', name: 'Low Stock', reorderLevel: 5, onHand: 2 });
    seedProduct({ id: 'p-eq', name: 'Equal', reorderLevel: 5, onHand: 5 });
    seedProduct({ id: 'p-ok', name: 'Plenty', reorderLevel: 5, onHand: 100 });

    const result = unwrapOk(await ProductService.list({ filter: { lowStockOnly: true } }));
    expect(result.rows.map((r) => r.id).sort()).toEqual(['p-eq', 'p-low']);
  });

  it('returns no rows when lowStockOnly is true and no products are low', async () => {
    seedProduct({ id: 'p-1', reorderLevel: 5, onHand: 100 });
    const result = unwrapOk(await ProductService.list({ filter: { lowStockOnly: true } }));
    expect(result.rows).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('searches by case-insensitive prefix on name and sku', async () => {
    seedProduct({ id: 'p-1', name: 'LED Lamp 9W', sku: 'LED-9' });
    seedProduct({ id: 'p-2', name: 'Filament Bulb', sku: 'FIL-1' });
    seedProduct({ id: 'p-3', name: 'Ledger Book', sku: 'BOOK-1' });

    const byName = unwrapOk(await ProductService.list({ search: 'led' }));
    expect(byName.rows.map((r) => r.id).sort()).toEqual(['p-1', 'p-3']);

    const bySku = unwrapOk(await ProductService.list({ search: 'fil' }));
    expect(bySku.rows.map((r) => r.id)).toEqual(['p-2']);
  });

  it('sorts by sku ascending when requested', async () => {
    seedProduct({ id: 'p-z', sku: 'ZZ-1', name: 'Zinger' });
    seedProduct({ id: 'p-a', sku: 'AA-1', name: 'Anchor' });
    seedProduct({ id: 'p-m', sku: 'MM-1', name: 'Mallet' });

    const result = unwrapOk(
      await ProductService.list({ sort: { key: 'sku', dir: 'asc' } }),
    );
    expect(result.rows.map((r) => r.sku)).toEqual(['AA-1', 'MM-1', 'ZZ-1']);
  });

  it('includes totalCount only when withCount is true and counts the filter set (not the cursor)', async () => {
    for (let i = 0; i < 6; i++) {
      seedProduct({ id: `p-${i}`, name: `Item ${i}`, sku: `S${i}` });
    }

    const without = unwrapOk(await ProductService.list({ pageSize: 2 }));
    expect('totalCount' in without).toBe(false);

    const first = unwrapOk(
      await ProductService.list({ pageSize: 2, sort: { key: 'name', dir: 'asc' }, withCount: true }),
    );
    expect(first.totalCount).toBe(6);

    const second = unwrapOk(
      await ProductService.list({
        pageSize: 2,
        sort: { key: 'name', dir: 'asc' },
        cursor: first.nextCursor!,
        withCount: true,
      }),
    );
    expect(second.totalCount).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe('ProductService.count', () => {
  it('returns the total count of all products on an empty filter', async () => {
    seedProduct();
    seedProduct();
    seedProduct();
    const result = unwrapOk(await ProductService.count({}));
    expect(result.totalCount).toBe(3);
  });

  it('respects categoryId filter', async () => {
    seedProduct({ categoryId: 'cat-1' });
    seedProduct({ categoryId: 'cat-1' });
    seedProduct({ categoryId: 'cat-2' });
    const result = unwrapOk(await ProductService.count({ filter: { categoryId: 'cat-1' } }));
    expect(result.totalCount).toBe(2);
  });

  it('respects search prefix', async () => {
    seedProduct({ name: 'Hammer Claw' });
    seedProduct({ name: 'Hammer Ball Peen' });
    seedProduct({ name: 'Wrench' });
    const result = unwrapOk(await ProductService.count({ search: 'hamm' }));
    expect(result.totalCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

describe('ProductService.getById', () => {
  it('returns the product with joined onHand', async () => {
    const id = seedProduct({ name: 'Hammer', onHand: 12 });
    const result = unwrapOk(await ProductService.getById(id));
    expect(result?.id).toBe(id);
    expect(result?.name).toBe('Hammer');
    expect(result?.onHand).toBe(12);
  });

  it('returns Ok(null) for an unknown id (not Err)', async () => {
    const result = unwrapOk(await ProductService.getById('does-not-exist'));
    expect(result).toBeNull();
  });

  it('returns VALIDATION on empty id', async () => {
    const result = await ProductService.getById('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'id' });
    }
  });
});

// ---------------------------------------------------------------------------
// getByBarcode
// ---------------------------------------------------------------------------

describe('ProductService.getByBarcode', () => {
  it('returns the product when the barcode matches the unique index', async () => {
    seedProduct({ id: 'p-bar', barcode: '1234567890123', name: 'Scanned' });
    const result = unwrapOk(await ProductService.getByBarcode('1234567890123'));
    expect(result?.id).toBe('p-bar');
    expect(result?.barcode).toBe('1234567890123');
  });

  it('returns Ok(null) for an unknown barcode', async () => {
    const result = unwrapOk(await ProductService.getByBarcode('no-such-barcode'));
    expect(result).toBeNull();
  });

  it('trims the input before lookup', async () => {
    seedProduct({ id: 'p-bar', barcode: '4002', name: 'Trim Test' });
    const result = unwrapOk(await ProductService.getByBarcode('  4002  '));
    expect(result?.id).toBe('p-bar');
  });

  it('returns Ok(null) on empty / whitespace barcode', async () => {
    const result = unwrapOk(await ProductService.getByBarcode('   '));
    expect(result).toBeNull();
  });

  it('returns VALIDATION on a non-string barcode', async () => {
    const result = await ProductService.getByBarcode(123 as unknown as string);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// upsert (create)
// ---------------------------------------------------------------------------

describe('ProductService.upsert (create)', () => {
  it('creates a product AND its inventory row with onHand=0 (Req 3.2, 11.4)', async () => {
    const dto = unwrapOk(await ProductService.upsert(baseInput, { userId: 'u-admin' }));
    expect(dto.id).toBe('prod-0');
    expect(dto.sku).toBe('SKU-1');
    expect(dto.name).toBe('Hammer 16oz');
    expect(dto.onHand).toBe(0);

    expect(mockState.state.products).toHaveLength(1);
    expect(mockState.state.inventories).toHaveLength(1);
    expect(mockState.state.inventories[0]!.productId).toBe('prod-0');
    expect(mockState.state.inventories[0]!.onHand).toBe(0);
  });

  it('trims surrounding whitespace from name and sku', async () => {
    const dto = unwrapOk(
      await ProductService.upsert(
        { ...baseInput, name: '  Padded Name  ', sku: '  SKU-PAD  ' },
        { userId: 'u-admin' },
      ),
    );
    expect(dto.name).toBe('Padded Name');
    expect(dto.sku).toBe('SKU-PAD');
  });

  it('rejects whitespace-only name', async () => {
    const result = await ProductService.upsert({ ...baseInput, name: '    ' }, { userId: 'u-admin' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'name' });
  });

  it('rejects name longer than 100 chars', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, name: 'a'.repeat(101) },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'name' });
  });

  it('rejects empty sku', async () => {
    const result = await ProductService.upsert({ ...baseInput, sku: '' }, { userId: 'u-admin' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'sku' });
  });

  it('rejects negative buyPrice', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, buyPrice: '-1' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'buyPrice' });
  });

  it('rejects non-numeric sellPrice string', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, sellPrice: 'abc' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'sellPrice' });
  });

  it('rejects non-integer warrantyMonths', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, warrantyMonths: 1.5 },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'warrantyMonths' });
  });

  it('rejects negative reorderLevel', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, reorderLevel: -1 },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'reorderLevel' });
  });

  it('accepts taxRate=0 (Req 2.6 — non-zero tax is the tax-applying case; zero must persist)', async () => {
    const dto = unwrapOk(
      await ProductService.upsert({ ...baseInput, taxRate: '0' }, { userId: 'u-admin' }),
    );
    expect(dto.taxRate).toBe('0');
  });

  it('accepts an explicit barcode and returns it on the DTO', async () => {
    const dto = unwrapOk(
      await ProductService.upsert(
        { ...baseInput, barcode: '1234567890123' },
        { userId: 'u-admin' },
      ),
    );
    expect(dto.barcode).toBe('1234567890123');
  });

  it('treats an omitted barcode as null on create', async () => {
    const dto = unwrapOk(await ProductService.upsert(baseInput, { userId: 'u-admin' }));
    expect(dto.barcode).toBeNull();
  });

  it('rejects barcode that is not a string', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, barcode: 123 as unknown as string },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'barcode' });
  });

  it('rejects barcode longer than 64 chars', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, barcode: '1'.repeat(65) },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'barcode' });
  });

  it('maps unique violation on sku to UNIQUE_VIOLATION { field: "sku" }', async () => {
    await ProductService.upsert(baseInput, { userId: 'u-admin' });
    const result = await ProductService.upsert(baseInput, { userId: 'u-admin' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNIQUE_VIOLATION');
      expect(result.error.details).toEqual({ field: 'sku' });
    }
    // Only the first product persisted; only one inventory row.
    expect(mockState.state.products).toHaveLength(1);
    expect(mockState.state.inventories).toHaveLength(1);
  });

  it('maps unique violation on barcode to UNIQUE_VIOLATION { field: "barcode" }', async () => {
    await ProductService.upsert(
      { ...baseInput, barcode: '1234567890123' },
      { userId: 'u-admin' },
    );
    const result = await ProductService.upsert(
      { ...baseInput, sku: 'SKU-OTHER', barcode: '1234567890123' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNIQUE_VIOLATION');
      expect(result.error.details).toEqual({ field: 'barcode' });
    }
  });

  it('maps a missing categoryId to FK_VIOLATION { field: "categoryId" }', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, categoryId: 'cat-missing' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ field: 'categoryId' });
    }
    // No persistence on FK failure.
    expect(mockState.state.products).toHaveLength(0);
    expect(mockState.state.inventories).toHaveLength(0);
  });

  it('rejects an empty categoryId string with VALIDATION before hitting the DB', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, categoryId: '' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'categoryId' });
    }
  });
});

// ---------------------------------------------------------------------------
// upsert (update)
// ---------------------------------------------------------------------------

describe('ProductService.upsert (update)', () => {
  beforeEach(() => {
    seedProduct({
      id: 'p-1',
      sku: 'SKU-1',
      name: 'Hammer',
      categoryId: 'cat-1',
      barcode: '111',
      buyPrice: '10',
      sellPrice: '15',
      taxRate: '0',
      onHand: 7,
    });
    seedProduct({
      id: 'p-2',
      sku: 'SKU-2',
      name: 'Lamp',
      categoryId: 'cat-2',
      barcode: '222',
    });
  });

  it('updates an existing product by id', async () => {
    const dto = unwrapOk(
      await ProductService.upsert(
        {
          id: 'p-1',
          sku: 'SKU-1',
          name: 'Hammer Pro',
          categoryId: 'cat-1',
          buyPrice: '11.50',
          sellPrice: '16.99',
          taxRate: '0.18',
          warrantyMonths: 12,
          reorderLevel: 8,
          barcode: '111',
        },
        { userId: 'u-admin' },
      ),
    );
    expect(dto.id).toBe('p-1');
    expect(dto.name).toBe('Hammer Pro');
    expect(dto.warrantyMonths).toBe(12);
    expect(dto.reorderLevel).toBe(8);
    // Inventory row is untouched.
    expect(mockState.state.inventories).toHaveLength(2);
    expect(mockState.state.inventories.find((i) => i.productId === 'p-1')!.onHand).toBe(7);
  });

  it('returns FK_VIOLATION { reason: "not_found" } when id does not exist', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, id: 'p-missing' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });

  it('maps a UNIQUE_VIOLATION on sku when renaming to another product\'s sku', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, id: 'p-1', sku: 'SKU-2' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNIQUE_VIOLATION');
      expect(result.error.details).toEqual({ field: 'sku' });
    }
  });

  it('maps a UNIQUE_VIOLATION on barcode when reassigning to another product\'s barcode', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, id: 'p-1', sku: 'SKU-1', barcode: '222' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNIQUE_VIOLATION');
      expect(result.error.details).toEqual({ field: 'barcode' });
    }
  });

  it('clears the barcode when input.barcode is null', async () => {
    const dto = unwrapOk(
      await ProductService.upsert(
        { ...baseInput, id: 'p-1', sku: 'SKU-1', barcode: null },
        { userId: 'u-admin' },
      ),
    );
    expect(dto.barcode).toBeNull();
  });

  it('clears the barcode when input.barcode is empty string (treated as null)', async () => {
    const dto = unwrapOk(
      await ProductService.upsert(
        { ...baseInput, id: 'p-1', sku: 'SKU-1', barcode: '' },
        { userId: 'u-admin' },
      ),
    );
    expect(dto.barcode).toBeNull();
  });

  it('maps a missing categoryId on update to FK_VIOLATION { field: "categoryId" }', async () => {
    const result = await ProductService.upsert(
      { ...baseInput, id: 'p-1', sku: 'SKU-1', categoryId: 'cat-missing' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ field: 'categoryId' });
    }
  });
});

// ---------------------------------------------------------------------------
// upsert (update) — price-change auditing (task 4.3)
// ---------------------------------------------------------------------------
//
// Validates: Requirements 2.4, 13.1.
//
// On the update path, when `buyPrice` or `sellPrice` differ from the
// persisted value, the service writes one `AuditLog` row of type
// `price.change` inside the same `$transaction` as the product
// update. The audit row carries `previous` / `next` JSON snapshots
// of both prices, the entity id, and the acting user. When neither
// price changed, no audit row is written.

describe('ProductService.upsert (update) — price-change auditing', () => {
  const seedInput = {
    sku: 'SKU-AUDIT',
    name: 'Audit Subject',
    categoryId: 'cat-1',
    buyPrice: '10.00',
    sellPrice: '15.00',
    taxRate: '0',
    warrantyMonths: 0,
    reorderLevel: 0,
  } as const;

  beforeEach(() => {
    seedProduct({
      id: 'p-audit',
      sku: 'SKU-AUDIT',
      name: 'Audit Subject',
      categoryId: 'cat-1',
      barcode: null,
      buyPrice: '10.00',
      sellPrice: '15.00',
      taxRate: '0',
      onHand: 0,
    });
  });

  it('writes a price.change audit row when buyPrice changes', async () => {
    expect(mockState.state.auditLogs).toHaveLength(0);
    const dto = unwrapOk(
      await ProductService.upsert(
        { ...seedInput, id: 'p-audit', buyPrice: '12.50' },
        { userId: 'u-admin' },
      ),
    );
    expect(dto.buyPrice).toBe('12.5');
    expect(mockState.state.auditLogs).toHaveLength(1);
    const row = mockState.state.auditLogs[0]!;
    expect(row.actionType).toBe('price.change');
    expect(row.entityType).toBe('product');
    expect(row.entityId).toBe('p-audit');
    expect(JSON.parse(row.previous!)).toEqual({ buyPrice: '10', sellPrice: '15' });
    expect(JSON.parse(row.next!)).toEqual({ buyPrice: '12.5', sellPrice: '15' });
  });

  it('writes a price.change audit row when sellPrice changes', async () => {
    const dto = unwrapOk(
      await ProductService.upsert(
        { ...seedInput, id: 'p-audit', sellPrice: '17.99' },
        { userId: 'u-admin' },
      ),
    );
    expect(dto.sellPrice).toBe('17.99');
    expect(mockState.state.auditLogs).toHaveLength(1);
    const row = mockState.state.auditLogs[0]!;
    expect(row.actionType).toBe('price.change');
    expect(JSON.parse(row.previous!)).toEqual({ buyPrice: '10', sellPrice: '15' });
    expect(JSON.parse(row.next!)).toEqual({ buyPrice: '10', sellPrice: '17.99' });
  });

  it('writes exactly one audit row when both prices change, capturing both fields', async () => {
    unwrapOk(
      await ProductService.upsert(
        { ...seedInput, id: 'p-audit', buyPrice: '11.00', sellPrice: '20.00' },
        { userId: 'u-admin' },
      ),
    );
    expect(mockState.state.auditLogs).toHaveLength(1);
    const row = mockState.state.auditLogs[0]!;
    expect(JSON.parse(row.previous!)).toEqual({ buyPrice: '10', sellPrice: '15' });
    expect(JSON.parse(row.next!)).toEqual({ buyPrice: '11', sellPrice: '20' });
  });

  it('writes NO audit row when neither price changes (only name update)', async () => {
    unwrapOk(
      await ProductService.upsert(
        { ...seedInput, id: 'p-audit', name: 'Renamed Only' },
        { userId: 'u-admin' },
      ),
    );
    expect(mockState.state.auditLogs).toHaveLength(0);
  });

  it('treats equivalent decimal representations as equal (no audit row for "10" vs "10.00")', async () => {
    unwrapOk(
      await ProductService.upsert(
        { ...seedInput, id: 'p-audit', buyPrice: '10.0000', sellPrice: '15' },
        { userId: 'u-admin' },
      ),
    );
    expect(mockState.state.auditLogs).toHaveLength(0);
  });

  it('attributes the audit row to ctx.userId', async () => {
    unwrapOk(
      await ProductService.upsert(
        { ...seedInput, id: 'p-audit', buyPrice: '12.00' },
        { userId: 'user-acting-42' },
      ),
    );
    expect(mockState.state.auditLogs).toHaveLength(1);
    expect(mockState.state.auditLogs[0]!.userId).toBe('user-acting-42');
  });

  it('writes one price.change journal entry alongside the audit row (Req 10.4)', async () => {
    expect(mockState.state.journalEntries).toHaveLength(0);
    unwrapOk(
      await ProductService.upsert(
        { ...seedInput, id: 'p-audit', buyPrice: '12.50', sellPrice: '20.00' },
        { userId: 'user-acting-7' },
      ),
    );
    // Audit and journal both fire, exactly once each — every business
    // `$transaction` ends with one `journal_entries` insert (task 11.4).
    expect(mockState.state.auditLogs).toHaveLength(1);
    expect(mockState.state.journalEntries).toHaveLength(1);

    const journal = mockState.state.journalEntries[0]!;
    expect(journal.opType).toBe('price.change');

    const payload = JSON.parse(journal.payload) as {
      productId: string;
      previous: { buyPrice: string; sellPrice: string };
      next: { buyPrice: string; sellPrice: string };
      userId: string;
      timestamp: string;
    };
    expect(payload.productId).toBe('p-audit');
    expect(payload.previous).toEqual({ buyPrice: '10', sellPrice: '15' });
    expect(payload.next).toEqual({ buyPrice: '12.5', sellPrice: '20' });
    expect(payload.userId).toBe('user-acting-7');
    expect(typeof payload.timestamp).toBe('string');
    expect(() => new Date(payload.timestamp).toISOString()).not.toThrow();
  });

  it('writes NO journal entry when neither price changes', async () => {
    unwrapOk(
      await ProductService.upsert(
        { ...seedInput, id: 'p-audit', name: 'Renamed Only' },
        { userId: 'u-admin' },
      ),
    );
    expect(mockState.state.journalEntries).toHaveLength(0);
  });

  it('writes no audit row when the update fails on FK_VIOLATION (atomic rollback contract)', async () => {
    const result = await ProductService.upsert(
      { ...seedInput, id: 'p-audit', categoryId: 'cat-missing', buyPrice: '99.00' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    // The fetch happens before the transaction, but the in-tx update
    // throws before the audit row is committed. The service returns
    // a mapped error envelope; both append-only logs stay empty
    // (atomic rollback covers the journal entry too — task 11.4).
    expect(mockState.state.auditLogs).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });

  it('writes no audit row when the update target id is missing (FK_VIOLATION not_found)', async () => {
    const result = await ProductService.upsert(
      { ...seedInput, id: 'p-missing', buyPrice: '99.00' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
    expect(mockState.state.auditLogs).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });
});
