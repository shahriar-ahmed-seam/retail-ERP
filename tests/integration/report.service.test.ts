// tests/integration/report.service.test.ts
//
// Phase 10, tasks 10.1–10.4 — Integration test for the four
// read-side report channels.
//
// Drives the real `ReportService` against a per-test SQLite database
// (via the `temp-db` fixture) and asserts that, after a handful of
// sales finalized through `POSService.finalizeSale`, the four report
// methods produce aggregations matching the seeded data:
//
//   - `dailySales({ date })` — sums revenue / tax / discount,
//     counts sales, breaks down payments by method.
//   - `monthlySales({ month })` — sums the headline figures for the
//     calendar month.
//   - `lowStockSummary()` — returns every product where
//     `onHand <= reorderLevel`.
//   - `topSelling({ dateFrom, dateTo })` — ranks products by total
//     units sold descending.
//
// The test uses the real Prisma + SQLite stack so the assertions
// cover Prisma's `aggregate` / `groupBy` query shapes, the SQL window
// predicates against `Sale.createdAt`, and the service-level
// Decimal-to-string conversion. Mocks would not catch a row-shape
// regression in any of those layers.
//
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 3.6.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDb, type TempDbFixture } from './fixtures/temp-db.js';

import type { FinalizeSaleInput, PaymentMethod } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Per-test seed shape
// ---------------------------------------------------------------------------

interface SeedData {
  readonly actor: { id: string; username: string };
  readonly products: readonly { id: string; sku: string; name: string }[];
}

async function seedFixtureData(fixture: TempDbFixture): Promise<SeedData> {
  const cashierRole = await fixture.prisma.role.findUniqueOrThrow({
    where: { name: 'Cashier' },
  });

  const actor = await fixture.prisma.user.create({
    data: {
      username: 'test-cashier',
      passwordHash: 'test-not-a-real-hash',
      roleId: cashierRole.id,
    },
  });

  const category = await fixture.prisma.category.create({
    data: { name: 'Test Category' },
  });

  // Three products. p1 is the high-mover, p2 is low-stock-only,
  // p3 is the unsold control.
  const p1 = await fixture.prisma.product.create({
    data: {
      sku: 'SKU-A',
      name: 'Alpha',
      categoryId: category.id,
      buyPrice: '5.00',
      sellPrice: '10.00',
      taxRate: '0.10',
      reorderLevel: 0,
    },
  });
  await fixture.prisma.inventory.create({ data: { productId: p1.id, onHand: 100 } });

  const p2 = await fixture.prisma.product.create({
    data: {
      sku: 'SKU-B',
      name: 'Beta',
      categoryId: category.id,
      buyPrice: '5.00',
      sellPrice: '20.00',
      taxRate: '0',
      // reorderLevel 5 with onHand 2 → low stock.
      reorderLevel: 5,
    },
  });
  await fixture.prisma.inventory.create({ data: { productId: p2.id, onHand: 2 } });

  const p3 = await fixture.prisma.product.create({
    data: {
      sku: 'SKU-C',
      name: 'Gamma',
      categoryId: category.id,
      buyPrice: '1.00',
      sellPrice: '3.00',
      taxRate: '0',
      reorderLevel: 0,
    },
  });
  await fixture.prisma.inventory.create({ data: { productId: p3.id, onHand: 50 } });

  return {
    actor: { id: actor.id, username: actor.username },
    products: [
      { id: p1.id, sku: p1.sku, name: p1.name },
      { id: p2.id, sku: p2.sku, name: p2.name },
      { id: p3.id, sku: p3.sku, name: p3.name },
    ],
  };
}

// ---------------------------------------------------------------------------
// Finalize-input builder
// ---------------------------------------------------------------------------

interface SaleSpec {
  readonly productId: string;
  readonly quantity: number;
  /** Per-unit decimal sell price as a string. */
  readonly unitPrice: string;
  /** Per-unit tax rate as a decimal string (e.g. `'0.10'`). */
  readonly taxRate: string;
  /** Payment method for the sale's single payment. */
  readonly method: PaymentMethod;
  /** Optional fixed discount in money units (default `'0'`). */
  readonly discount?: string;
}

/**
 * Build a single-line, single-payment finalize input from a `SaleSpec`.
 * Computes `subtotal`, `discountAmount`, `taxTotal`, and `grandTotal`
 * exactly the way `validateTotalsIdentity` re-validates them inside
 * the transaction so the sale finalizes without a `VALIDATION` envelope.
 */
function makeInput(spec: SaleSpec): FinalizeSaleInput {
  const qty = spec.quantity;
  const unit = Number.parseFloat(spec.unitPrice);
  const tax = Number.parseFloat(spec.taxRate);
  const lineTotalNum = qty * unit;
  const discountNum = Number.parseFloat(spec.discount ?? '0');
  const subtotalNum = lineTotalNum;
  const discountedSubtotal = subtotalNum - discountNum;
  // POS totals math allocates discount proportionally; with one line
  // the line takes the full discount.
  const taxTotalNum = discountedSubtotal * tax;
  const grandTotalNum = discountedSubtotal + taxTotalNum;
  const fmt = (n: number): string => n.toFixed(2);

  return {
    items: [
      {
        productId: spec.productId,
        quantity: qty,
        unitPrice: spec.unitPrice,
        taxRate: spec.taxRate,
        lineTotal: fmt(lineTotalNum),
      },
    ],
    discount: { kind: 'fixed', amount: fmt(discountNum) },
    subtotal: fmt(subtotalNum),
    discountAmount: fmt(discountNum),
    taxTotal: fmt(taxTotalNum),
    grandTotal: fmt(grandTotalNum),
    payments: [{ method: spec.method, amount: fmt(grandTotalNum) }],
  };
}

/**
 * Spreads `Sale.createdAt` across distinct millisecond timestamps so
 * date-range filters and DESC ordering remain unambiguous on every
 * host. Calls `setTimeout(2 ms)` between finalize calls; SQLite
 * stores DATETIME at millisecond resolution.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fixture: TempDbFixture;
let seed: SeedData;

beforeEach(async () => {
  fixture = await createTempDb();
  seed = await seedFixtureData(fixture);
});

afterEach(async () => {
  await fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Reports — happy path with seeded sales
// ---------------------------------------------------------------------------

describe('ReportService — integration with finalized sales', () => {
  it('aggregates dailySales, monthlySales, and topSelling matching the seeded data', async () => {
    const [p1, p2] = seed.products;
    if (p1 === undefined || p2 === undefined) {
      throw new Error('seed missing expected products');
    }

    // Sale 1 — p1, qty 3, unit 10, tax 10%, cash. line=30, tax=3, grand=33.
    const r1 = await fixture.POSService.finalizeSale(
      makeInput({
        productId: p1.id,
        quantity: 3,
        unitPrice: '10.00',
        taxRate: '0.10',
        method: 'cash',
      }),
      { userId: seed.actor.id },
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    await sleep(2);

    // Sale 2 — p1, qty 2, unit 10, tax 10%, fixed discount 5, card.
    // line=20, post-discount=15, tax=1.5, grand=16.5.
    const r2 = await fixture.POSService.finalizeSale(
      makeInput({
        productId: p1.id,
        quantity: 2,
        unitPrice: '10.00',
        taxRate: '0.10',
        method: 'card',
        discount: '5.00',
      }),
      { userId: seed.actor.id },
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    await sleep(2);

    // Sale 3 — p2, qty 1, unit 20, tax 0, mobile. grand=20.
    const r3 = await fixture.POSService.finalizeSale(
      makeInput({
        productId: p2.id,
        quantity: 1,
        unitPrice: '20.00',
        taxRate: '0',
        method: 'mobile',
      }),
      { userId: seed.actor.id },
    );
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;

    // The temp-db fixture uses `now()` at finalize time; rather than
    // reverse-engineer the date the database recorded, read the
    // first sale's `createdAt` and compute the reporting day from
    // it. SQLite stores millisecond-precision UTC; converting to
    // YYYY-MM-DD via `toISOString` is unambiguous.
    const firstSale = await fixture.prisma.sale.findUniqueOrThrow({
      where: { id: r1.value.saleId },
    });
    const dayString = firstSale.createdAt.toISOString().slice(0, 10);
    const monthString = dayString.slice(0, 7);

    // ---- dailySales --------------------------------------------------
    const dailyResult = await fixture.ReportService.dailySales({ date: dayString });
    expect(dailyResult.ok).toBe(true);
    if (!dailyResult.ok) return;
    const daily = dailyResult.value;

    expect(daily.date).toBe(dayString);
    expect(daily.salesCount).toBe(3);
    // Revenue = 33 + 16.5 + 20 = 69.5
    expect(Number.parseFloat(daily.totalRevenue)).toBeCloseTo(69.5, 2);
    // Tax = 3 + 1.5 + 0 = 4.5
    expect(Number.parseFloat(daily.totalTax)).toBeCloseTo(4.5, 2);
    // Discount = 0 + 5 + 0 = 5
    expect(Number.parseFloat(daily.totalDiscount)).toBeCloseTo(5, 2);

    // Payment breakdown — sorted cash → card → mobile.
    expect(daily.paymentBreakdown).toHaveLength(3);
    const byMethod = new Map(
      daily.paymentBreakdown.map((row) => [row.method, row.amount]),
    );
    expect(Number.parseFloat(byMethod.get('cash') ?? '0')).toBeCloseTo(33, 2);
    expect(Number.parseFloat(byMethod.get('card') ?? '0')).toBeCloseTo(16.5, 2);
    expect(Number.parseFloat(byMethod.get('mobile') ?? '0')).toBeCloseTo(20, 2);
    // Order is cash → card → mobile.
    expect(daily.paymentBreakdown.map((r) => r.method)).toEqual([
      'cash',
      'card',
      'mobile',
    ]);

    // ---- monthlySales -----------------------------------------------
    const monthlyResult = await fixture.ReportService.monthlySales({ month: monthString });
    expect(monthlyResult.ok).toBe(true);
    if (!monthlyResult.ok) return;
    const monthly = monthlyResult.value;
    expect(monthly.month).toBe(monthString);
    expect(monthly.salesCount).toBe(3);
    expect(Number.parseFloat(monthly.totalRevenue)).toBeCloseTo(69.5, 2);
    expect(Number.parseFloat(monthly.totalTax)).toBeCloseTo(4.5, 2);
    expect(Number.parseFloat(monthly.totalDiscount)).toBeCloseTo(5, 2);

    // ---- topSelling --------------------------------------------------
    const topResult = await fixture.ReportService.topSelling({
      dateFrom: dayString,
      dateTo: dayString,
    });
    expect(topResult.ok).toBe(true);
    if (!topResult.ok) return;

    // p1 sold 5 units (3 + 2), p2 sold 1 unit, p3 sold none.
    const topRows = topResult.value.rows;
    expect(topRows).toHaveLength(2);
    expect(topRows[0]).toMatchObject({
      productId: p1.id,
      sku: p1.sku,
      name: p1.name,
      unitsSold: 5,
    });
    expect(topRows[1]).toMatchObject({
      productId: p2.id,
      sku: p2.sku,
      name: p2.name,
      unitsSold: 1,
    });
    // Revenue projection — sum of lineTotal (pre-discount, pre-tax).
    // p1: 30 + 20 = 50. p2: 20.
    expect(Number.parseFloat(topRows[0]?.revenue ?? '0')).toBeCloseTo(50, 2);
    expect(Number.parseFloat(topRows[1]?.revenue ?? '0')).toBeCloseTo(20, 2);
  });

  it('returns an empty paymentBreakdown and zero totals on a day with no sales', async () => {
    const result = await fixture.ReportService.dailySales({ date: '2099-01-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.salesCount).toBe(0);
    expect(result.value.totalRevenue).toBe('0');
    expect(result.value.paymentBreakdown).toEqual([]);
  });

  it('lowStockSummary surfaces only products where onHand <= reorderLevel', async () => {
    const result = await fixture.ReportService.lowStockSummary();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // p2 was seeded with onHand 2, reorderLevel 5 — must appear.
    // p1 (reorder 0, onHand 100) and p3 (reorder 0, onHand 50) must not.
    const skus = result.value.rows.map((r) => r.sku);
    expect(skus).toContain('SKU-B');
    expect(skus).not.toContain('SKU-A');
    expect(skus).not.toContain('SKU-C');

    const beta = result.value.rows.find((r) => r.sku === 'SKU-B');
    expect(beta).toBeDefined();
    expect(beta?.onHand).toBe(2);
    expect(beta?.reorderLevel).toBe(5);
  });
});
