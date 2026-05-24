import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `ReportService` (Phase 10, tasks 10.1–10.4).
 *
 * Drives the four read-side report methods against an in-memory mock
 * of the Prisma delegates each path touches:
 *
 *   - `dailySales`:        `sale.aggregate`, `payment.groupBy`.
 *   - `monthlySales`:      `sale.aggregate`.
 *   - `lowStockSummary`:   forwards to `InventoryService.lowStockList`.
 *   - `topSelling`:        `saleItem.groupBy`, `product.findMany`.
 *
 * The mock uses `Prisma.Decimal` for monetary sums so the wire-format
 * conversion (Decimal → string via `decimal.js`) is exercised end-to-
 * end. Empty-result-set paths are covered alongside the happy paths.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 3.6.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock + InventoryService mock
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockSale {
    id: string;
    grandTotal: string;
    taxTotal: string;
    discount: string;
    createdAt: Date;
  }
  interface MockSaleItem {
    productId: string;
    quantity: number;
    lineTotal: string;
    saleCreatedAt: Date;
  }
  interface MockPayment {
    method: string;
    amount: string;
    saleCreatedAt: Date;
  }
  interface MockProduct {
    id: string;
    sku: string;
    name: string;
  }

  const state = {
    sales: [] as MockSale[],
    saleItems: [] as MockSaleItem[],
    payments: [] as MockPayment[],
    products: [] as MockProduct[],
  };

  return {
    state,
    reset(): void {
      state.sales = [];
      state.saleItems = [];
      state.payments = [];
      state.products = [];
    },
  };
});

const inventoryMock = vi.hoisted(() => ({
  lowStockList: vi.fn(),
}));

vi.mock('@main/services/inventory.service.js', () => ({
  InventoryService: inventoryMock,
}));

vi.mock('@main/services/inventory.service', () => ({
  InventoryService: inventoryMock,
}));

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  interface DecimalLike {
    toString(): string;
    plus(other: DecimalLike): DecimalLike;
  }
  const D = (value: number | string): DecimalLike =>
    new Prisma.Decimal(value) as unknown as DecimalLike;

  type MockSale = (typeof state.sales)[number];
  type MockSaleItem = (typeof state.saleItems)[number];
  type MockPayment = (typeof state.payments)[number];

  /** Apply a `{ gte, lt }` predicate against a Date column. */
  function inWindow(when: Date, predicate: { gte?: Date; lt?: Date } | undefined): boolean {
    if (predicate === undefined) return true;
    if (predicate.gte !== undefined && when.getTime() < predicate.gte.getTime()) return false;
    if (predicate.lt !== undefined && when.getTime() >= predicate.lt.getTime()) return false;
    return true;
  }

  function saleMatches(row: MockSale, where: Record<string, unknown> | undefined): boolean {
    if (where === undefined) return true;
    const createdAt = where.createdAt as { gte?: Date; lt?: Date } | undefined;
    return inWindow(row.createdAt, createdAt);
  }

  function saleItemMatches(
    row: MockSaleItem,
    where: Record<string, unknown> | undefined,
  ): boolean {
    if (where === undefined) return true;
    const sale = where.sale as { createdAt?: { gte?: Date; lt?: Date } } | undefined;
    return inWindow(row.saleCreatedAt, sale?.createdAt);
  }

  function paymentMatches(
    row: MockPayment,
    where: Record<string, unknown> | undefined,
  ): boolean {
    if (where === undefined) return true;
    const sale = where.sale as { createdAt?: { gte?: Date; lt?: Date } } | undefined;
    return inWindow(row.saleCreatedAt, sale?.createdAt);
  }

  // ---- sale.aggregate -------------------------------------------------
  function saleAggregateImpl(args: {
    where?: Record<string, unknown>;
    _count?: { _all?: boolean };
    _sum?: { grandTotal?: boolean; taxTotal?: boolean; discount?: boolean };
  }): Promise<{
    _count: { _all: number };
    _sum: {
      grandTotal: DecimalLike | null;
      taxTotal: DecimalLike | null;
      discount: DecimalLike | null;
    };
  }> {
    const rows = state.sales.filter((r) => saleMatches(r, args.where));
    const sum = (key: 'grandTotal' | 'taxTotal' | 'discount'): DecimalLike | null => {
      if (rows.length === 0) return null;
      let total = D(0);
      for (const r of rows) total = total.plus(D(r[key]));
      return total;
    };
    return Promise.resolve({
      _count: { _all: rows.length },
      _sum: {
        grandTotal: args._sum?.grandTotal === true ? sum('grandTotal') : null,
        taxTotal: args._sum?.taxTotal === true ? sum('taxTotal') : null,
        discount: args._sum?.discount === true ? sum('discount') : null,
      },
    });
  }

  // ---- payment.groupBy ------------------------------------------------
  function paymentGroupByImpl(args: {
    by: readonly string[];
    where?: Record<string, unknown>;
    _sum?: { amount?: boolean };
  }): Promise<{ method: string; _sum: { amount: DecimalLike | null } }[]> {
    const rows = state.payments.filter((r) => paymentMatches(r, args.where));
    const totalsByMethod = new Map<string, DecimalLike>();
    for (const r of rows) {
      const cur = totalsByMethod.get(r.method) ?? D(0);
      totalsByMethod.set(r.method, cur.plus(D(r.amount)));
    }
    return Promise.resolve(
      Array.from(totalsByMethod.entries()).map(([method, amount]) => ({
        method,
        _sum: { amount: args._sum?.amount === true ? amount : null },
      })),
    );
  }

  // ---- saleItem.groupBy -----------------------------------------------
  function saleItemGroupByImpl(args: {
    by: readonly string[];
    where?: Record<string, unknown>;
    _sum?: { quantity?: boolean; lineTotal?: boolean };
    orderBy?: readonly Record<string, unknown>[];
    take?: number;
  }): Promise<
    {
      productId: string;
      _sum: { quantity: number | null; lineTotal: DecimalLike | null };
    }[]
  > {
    const rows = state.saleItems.filter((r) => saleItemMatches(r, args.where));
    const totals = new Map<string, { quantity: number; lineTotal: DecimalLike }>();
    for (const r of rows) {
      const cur = totals.get(r.productId) ?? {
        quantity: 0,
        lineTotal: D(0),
      };
      cur.quantity += r.quantity;
      cur.lineTotal = cur.lineTotal.plus(D(r.lineTotal));
      totals.set(r.productId, cur);
    }
    let grouped = Array.from(totals.entries()).map(([productId, t]) => ({
      productId,
      _sum: {
        quantity: args._sum?.quantity === true ? t.quantity : null,
        lineTotal: args._sum?.lineTotal === true ? t.lineTotal : null,
      },
    }));

    // Apply `orderBy: [{ _sum: { quantity: 'desc' } }, { productId: 'asc' }]`.
    grouped = grouped.sort((a, b) => {
      const aq = a._sum.quantity ?? 0;
      const bq = b._sum.quantity ?? 0;
      if (aq !== bq) return bq - aq;
      return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
    });
    if (typeof args.take === 'number') grouped = grouped.slice(0, args.take);
    return Promise.resolve(grouped);
  }

  // ---- product.findMany ------------------------------------------------
  function productFindManyImpl(args: {
    where?: { id?: { in?: readonly string[] } };
    select?: { id?: boolean; sku?: boolean; name?: boolean };
  }): Promise<{ id: string; sku: string; name: string }[]> {
    const ids = args.where?.id?.in ?? [];
    const idSet = new Set(ids);
    const rows = state.products.filter((p) => idSet.has(p.id));
    return Promise.resolve(rows.map((p) => ({ id: p.id, sku: p.sku, name: p.name })));
  }

  return {
    prisma: {
      sale: {
        aggregate: saleAggregateImpl,
      },
      payment: {
        groupBy: paymentGroupByImpl,
      },
      saleItem: {
        groupBy: saleItemGroupByImpl,
      },
      product: {
        findMany: productFindManyImpl,
      },
    },
  };
});

// Imports MUST come after `vi.mock`.
import { ReportService } from '@main/services/report.service';
import { Ok } from '@shared/result';

import type { LowStockRow, PaymentMethod } from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapOk<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { code: string; details?: unknown } },
): T {
  if (!result.ok) {
    throw new Error(`expected Ok, got Err(${result.error.code})`);
  }
  return result.value;
}

function seedSale(overrides: Partial<{
  id: string;
  grandTotal: string;
  taxTotal: string;
  discount: string;
  createdAt: Date;
}> = {}): string {
  const id = overrides.id ?? `sal-${mockState.state.sales.length}`;
  mockState.state.sales.push({
    id,
    grandTotal: overrides.grandTotal ?? '100.00',
    taxTotal: overrides.taxTotal ?? '0',
    discount: overrides.discount ?? '0',
    createdAt: overrides.createdAt ?? new Date('2024-05-15T10:00:00Z'),
  });
  return id;
}

function seedPayment(overrides: Partial<{
  method: string;
  amount: string;
  saleCreatedAt: Date;
}> = {}): void {
  mockState.state.payments.push({
    method: overrides.method ?? 'cash',
    amount: overrides.amount ?? '50.00',
    saleCreatedAt: overrides.saleCreatedAt ?? new Date('2024-05-15T10:00:00Z'),
  });
}

function seedSaleItem(overrides: Partial<{
  productId: string;
  quantity: number;
  lineTotal: string;
  saleCreatedAt: Date;
}> = {}): void {
  mockState.state.saleItems.push({
    productId: overrides.productId ?? 'p-1',
    quantity: overrides.quantity ?? 1,
    lineTotal: overrides.lineTotal ?? '10.00',
    saleCreatedAt: overrides.saleCreatedAt ?? new Date('2024-05-15T10:00:00Z'),
  });
}

function seedProduct(overrides: Partial<{
  id: string;
  sku: string;
  name: string;
}> = {}): string {
  const id = overrides.id ?? `p-${mockState.state.products.length}`;
  mockState.state.products.push({
    id,
    sku: overrides.sku ?? `SKU-${id}`,
    name: overrides.name ?? `Product ${id}`,
  });
  return id;
}

beforeEach(() => {
  mockState.reset();
  inventoryMock.lowStockList.mockReset();
});

afterEach(() => {
  mockState.reset();
  inventoryMock.lowStockList.mockReset();
});

// ---------------------------------------------------------------------------
// dailySales — Req 9.1
// ---------------------------------------------------------------------------

describe('ReportService.dailySales', () => {
  it('returns zeroed totals on a day with no sales', async () => {
    const result = unwrapOk(await ReportService.dailySales({ date: '2024-05-15' }));
    expect(result.date).toBe('2024-05-15');
    expect(result.salesCount).toBe(0);
    expect(result.totalRevenue).toBe('0');
    expect(result.totalTax).toBe('0');
    expect(result.totalDiscount).toBe('0');
    expect(result.paymentBreakdown).toEqual([]);
  });

  it('aggregates revenue, tax, and discount over the requested UTC day', async () => {
    seedSale({
      grandTotal: '100.00',
      taxTotal: '18.00',
      discount: '5.00',
      createdAt: new Date('2024-05-15T01:00:00Z'),
    });
    seedSale({
      grandTotal: '50.50',
      taxTotal: '4.50',
      discount: '0',
      createdAt: new Date('2024-05-15T23:59:59.999Z'),
    });
    // Sales outside the window must NOT contribute.
    seedSale({
      grandTotal: '999',
      taxTotal: '999',
      discount: '999',
      createdAt: new Date('2024-05-14T23:59:59.999Z'),
    });
    seedSale({
      grandTotal: '999',
      taxTotal: '999',
      discount: '999',
      createdAt: new Date('2024-05-16T00:00:00.000Z'),
    });

    const result = unwrapOk(await ReportService.dailySales({ date: '2024-05-15' }));
    expect(result.salesCount).toBe(2);
    expect(result.totalRevenue).toBe('150.5');
    expect(result.totalTax).toBe('22.5');
    expect(result.totalDiscount).toBe('5');
  });

  it('produces a per-payment-method breakdown sorted cash → card → mobile', async () => {
    seedSale({ createdAt: new Date('2024-05-15T10:00:00Z') });
    seedPayment({ method: 'mobile', amount: '20', saleCreatedAt: new Date('2024-05-15T10:00:00Z') });
    seedPayment({ method: 'cash', amount: '15', saleCreatedAt: new Date('2024-05-15T10:00:00Z') });
    seedPayment({ method: 'cash', amount: '10', saleCreatedAt: new Date('2024-05-15T11:00:00Z') });
    seedPayment({ method: 'card', amount: '5', saleCreatedAt: new Date('2024-05-15T10:00:00Z') });
    // Outside the window: must NOT appear.
    seedPayment({ method: 'card', amount: '999', saleCreatedAt: new Date('2024-05-16T10:00:00Z') });

    const result = unwrapOk(await ReportService.dailySales({ date: '2024-05-15' }));
    expect(result.paymentBreakdown).toEqual([
      { method: 'cash' satisfies PaymentMethod, amount: '25' },
      { method: 'card' satisfies PaymentMethod, amount: '5' },
      { method: 'mobile' satisfies PaymentMethod, amount: '20' },
    ]);
  });

  it('omits payment methods with no contribution rather than emitting zeros', async () => {
    seedPayment({ method: 'cash', amount: '10', saleCreatedAt: new Date('2024-05-15T10:00:00Z') });
    const result = unwrapOk(await ReportService.dailySales({ date: '2024-05-15' }));
    expect(result.paymentBreakdown).toHaveLength(1);
    expect(result.paymentBreakdown[0]?.method).toBe('cash');
  });

  it('rejects malformed date strings', async () => {
    const r1 = await ReportService.dailySales({ date: '2024-13-01' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.details).toEqual({ field: 'date' });

    const r2 = await ReportService.dailySales({ date: 'not-a-date' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.details).toEqual({ field: 'date' });

    const r3 = await ReportService.dailySales({ date: '2024-02-30' });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.details).toEqual({ field: 'date' });
  });
});

// ---------------------------------------------------------------------------
// monthlySales — Req 9.2
// ---------------------------------------------------------------------------

describe('ReportService.monthlySales', () => {
  it('returns zeroed totals on a month with no sales', async () => {
    const result = unwrapOk(await ReportService.monthlySales({ month: '2024-05' }));
    expect(result.month).toBe('2024-05');
    expect(result.salesCount).toBe(0);
    expect(result.totalRevenue).toBe('0');
    expect(result.totalTax).toBe('0');
    expect(result.totalDiscount).toBe('0');
  });

  it('aggregates revenue, tax, and discount over the requested UTC month', async () => {
    seedSale({
      grandTotal: '100',
      taxTotal: '18',
      discount: '5',
      createdAt: new Date('2024-05-01T00:00:00Z'),
    });
    seedSale({
      grandTotal: '50',
      taxTotal: '9',
      discount: '0',
      createdAt: new Date('2024-05-31T23:59:59.999Z'),
    });
    // Outside the window.
    seedSale({
      grandTotal: '999',
      taxTotal: '999',
      discount: '999',
      createdAt: new Date('2024-04-30T23:59:59.999Z'),
    });
    seedSale({
      grandTotal: '999',
      taxTotal: '999',
      discount: '999',
      createdAt: new Date('2024-06-01T00:00:00.000Z'),
    });

    const result = unwrapOk(await ReportService.monthlySales({ month: '2024-05' }));
    expect(result.salesCount).toBe(2);
    expect(result.totalRevenue).toBe('150');
    expect(result.totalTax).toBe('27');
    expect(result.totalDiscount).toBe('5');
  });

  it('handles year rollover (December → January)', async () => {
    seedSale({ grandTotal: '10', createdAt: new Date('2024-12-31T23:59:59.999Z') });
    seedSale({
      grandTotal: '20',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    seedSale({
      grandTotal: '30',
      createdAt: new Date('2025-01-31T23:59:59.999Z'),
    });

    const dec = unwrapOk(await ReportService.monthlySales({ month: '2024-12' }));
    expect(dec.salesCount).toBe(1);
    expect(dec.totalRevenue).toBe('10');

    const jan = unwrapOk(await ReportService.monthlySales({ month: '2025-01' }));
    expect(jan.salesCount).toBe(2);
    expect(jan.totalRevenue).toBe('50');
  });

  it('rejects malformed month strings', async () => {
    const r1 = await ReportService.monthlySales({ month: '2024-13' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.details).toEqual({ field: 'month' });

    const r2 = await ReportService.monthlySales({ month: 'not-a-month' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.details).toEqual({ field: 'month' });

    const r3 = await ReportService.monthlySales({ month: '2024-05-01' });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.details).toEqual({ field: 'month' });
  });
});

// ---------------------------------------------------------------------------
// lowStockSummary — Req 9.3, 3.6
// ---------------------------------------------------------------------------

describe('ReportService.lowStockSummary', () => {
  it('forwards to InventoryService.lowStockList unchanged', async () => {
    const rows: readonly LowStockRow[] = Object.freeze([
      Object.freeze({
        productId: 'p-1',
        sku: 'SKU-1',
        name: 'Widget',
        onHand: 1,
        reorderLevel: 5,
      }),
    ]);
    inventoryMock.lowStockList.mockResolvedValue(Ok({ rows }));

    const result = unwrapOk(await ReportService.lowStockSummary());
    expect(result.rows).toBe(rows);
    expect(inventoryMock.lowStockList).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when no products are low', async () => {
    inventoryMock.lowStockList.mockResolvedValue(Ok({ rows: [] }));
    const result = unwrapOk(await ReportService.lowStockSummary());
    expect(result.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// topSelling — Req 9.4
// ---------------------------------------------------------------------------

describe('ReportService.topSelling', () => {
  it('returns rows ordered by units sold DESC, tie-broken by productId ASC', async () => {
    seedProduct({ id: 'p-1', sku: 'A', name: 'Alpha' });
    seedProduct({ id: 'p-2', sku: 'B', name: 'Beta' });
    seedProduct({ id: 'p-3', sku: 'C', name: 'Gamma' });

    const inWindow = new Date('2024-05-15T10:00:00Z');
    // p-1 → 3 + 2 = 5 units, revenue 30 + 20 = 50
    seedSaleItem({ productId: 'p-1', quantity: 3, lineTotal: '30', saleCreatedAt: inWindow });
    seedSaleItem({ productId: 'p-1', quantity: 2, lineTotal: '20', saleCreatedAt: inWindow });
    // p-2 → 7 units, revenue 70
    seedSaleItem({ productId: 'p-2', quantity: 7, lineTotal: '70', saleCreatedAt: inWindow });
    // p-3 → 5 units, revenue 500 (ties with p-1; p-1 < p-3 lexicographically wins)
    seedSaleItem({ productId: 'p-3', quantity: 5, lineTotal: '500', saleCreatedAt: inWindow });

    const result = unwrapOk(
      await ReportService.topSelling({ dateFrom: '2024-05-01', dateTo: '2024-05-31' }),
    );
    expect(result.rows).toHaveLength(3);
    // p-2 wins outright at 7. p-1 and p-3 tie at 5; p-1 < p-3.
    expect(result.rows[0]).toEqual({
      productId: 'p-2',
      sku: 'B',
      name: 'Beta',
      unitsSold: 7,
      revenue: '70',
    });
    expect(result.rows[1]).toEqual({
      productId: 'p-1',
      sku: 'A',
      name: 'Alpha',
      unitsSold: 5,
      revenue: '50',
    });
    expect(result.rows[2]).toEqual({
      productId: 'p-3',
      sku: 'C',
      name: 'Gamma',
      unitsSold: 5,
      revenue: '500',
    });
  });

  it('treats dateTo as inclusive (covers sales committed on dateTo at 23:59)', async () => {
    seedProduct({ id: 'p-1' });
    seedSaleItem({
      productId: 'p-1',
      quantity: 1,
      lineTotal: '10',
      saleCreatedAt: new Date('2024-05-15T23:59:59.999Z'),
    });
    // Outside the window.
    seedSaleItem({
      productId: 'p-1',
      quantity: 100,
      lineTotal: '1000',
      saleCreatedAt: new Date('2024-05-16T00:00:00Z'),
    });
    const result = unwrapOk(
      await ReportService.topSelling({ dateFrom: '2024-05-15', dateTo: '2024-05-15' }),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.unitsSold).toBe(1);
  });

  it('returns an empty list on an empty window', async () => {
    seedProduct({ id: 'p-1' });
    const result = unwrapOk(
      await ReportService.topSelling({ dateFrom: '2024-05-01', dateTo: '2024-05-31' }),
    );
    expect(result.rows).toEqual([]);
  });

  it('respects the requested limit and clamps it to [1, 200]', async () => {
    for (let i = 0; i < 5; i++) {
      seedProduct({ id: `p-${i}` });
      seedSaleItem({
        productId: `p-${i}`,
        quantity: 10 - i,
        lineTotal: `${(10 - i) * 10}`,
        saleCreatedAt: new Date('2024-05-15T10:00:00Z'),
      });
    }
    const limited = unwrapOk(
      await ReportService.topSelling({
        dateFrom: '2024-05-01',
        dateTo: '2024-05-31',
        limit: 2,
      }),
    );
    expect(limited.rows).toHaveLength(2);
    expect(limited.rows.map((r) => r.productId)).toEqual(['p-0', 'p-1']);

    const huge = unwrapOk(
      await ReportService.topSelling({
        dateFrom: '2024-05-01',
        dateTo: '2024-05-31',
        limit: 1_000_000,
      }),
    );
    expect(huge.rows.length).toBeLessThanOrEqual(200);
  });

  it('rejects malformed dateFrom / dateTo with VALIDATION', async () => {
    const r1 = await ReportService.topSelling({ dateFrom: 'bad', dateTo: '2024-05-31' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.details).toEqual({ field: 'dateFrom' });

    const r2 = await ReportService.topSelling({ dateFrom: '2024-05-01', dateTo: 'bad' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.details).toEqual({ field: 'dateTo' });
  });

  it('rejects an inverted range with VALIDATION', async () => {
    const result = await ReportService.topSelling({
      dateFrom: '2024-05-31',
      dateTo: '2024-05-01',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toEqual({ field: 'range' });
  });

  it('drops rows whose product disappeared between groupBy and findMany', async () => {
    // SaleItem references p-ghost but no matching Product row exists.
    seedSaleItem({
      productId: 'p-ghost',
      quantity: 5,
      lineTotal: '50',
      saleCreatedAt: new Date('2024-05-15T10:00:00Z'),
    });
    seedProduct({ id: 'p-real' });
    seedSaleItem({
      productId: 'p-real',
      quantity: 1,
      lineTotal: '10',
      saleCreatedAt: new Date('2024-05-15T10:00:00Z'),
    });
    const result = unwrapOk(
      await ReportService.topSelling({ dateFrom: '2024-05-01', dateTo: '2024-05-31' }),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.productId).toBe('p-real');
  });
});
