// tests/property/report-aggregates.property.test.ts
//
// Phase 10, task 10.10 — Property 10: Report aggregates equal SQL aggregates.
//
// **Validates: Requirements 6.2, 6.3, 7.3, 9.1, 9.2, 9.3, 9.4.**
//
// design.md > "Property 10: Report aggregates equal SQL aggregates":
//   For any report (daily sales, monthly sales, low-stock summary,
//   top-selling, supplier purchase history, customer purchase
//   history) and any underlying data set, the values returned by the
//   report service equal the corresponding SQL aggregates (sums,
//   counts, group-bys, filters, sort orders) computed independently
//   against the same data set.
//
// For V1 the four exposed reports are `dailySales`, `monthlySales`,
// `lowStockSummary`, and `topSelling` (Phase 10 tasks 10.1–10.4 +
// `src/main/services/report.service.ts`). The supplier / customer
// purchase-history projections are validated separately by the
// list-channel property tests in Phase 6 / 9. This file therefore
// exercises the four V1 reports end-to-end.
//
// Strategy:
//
//   1. Per fast-check iteration: spin up a fresh per-test SQLite via
//      `createTempDb()` (the conventional property/integration
//      fixture). Each iteration owns its own DB so writes from a
//      previous shrink can not bleed into the next one. Cleanup is
//      `try/finally` so a failing assertion still releases the file
//      handle and deletes the temp `.db`.
//
//   2. Generate a random workload (1–6 products, 0–8 sales, each
//      sale with 1–3 line items, a random discount, one random
//      payment method, and a random date offset within a fixed
//      30-day window). Quantities are generated first so we can
//      pre-compute per-product demand and seed `Inventory.onHand`
//      large enough to absorb every sale without an OUT_OF_STOCK
//      envelope — but with a small random "buffer" left over so a
//      meaningful subset of products comes in at or below their
//      `reorderLevel` for the low-stock report.
//
//   3. Persist actor / supplier / category / products / inventory
//      through the per-test Prisma client, then drive every sale
//      through `POSService.finalizeSale`. The renderer-supplied
//      totals are computed via the SAME `@shared/pos-totals`
//      module the SUT re-runs inside its transaction (`Property 2`
//      already proves these totals match the persisted columns
//      exactly), so every finalize commits on the first try.
//
//   4. Right after each finalize, override the persisted
//      `Sale.createdAt` to the workload's chosen UTC timestamp via
//      a direct `prisma.sale.update`. The SQL date predicates that
//      every report relies on are driven from `Sale.createdAt`, so
//      pinning it deterministically lets the report assertions
//      target a fixed window without flake from clock drift across
//      30 iterations.
//
//   5. Compute a JS-only reference for every report by aggregating
//      the SAME workload in memory (NOT another SQL query). The
//      reference uses `decimal.js` so its arithmetic shares
//      decimal.js's precision with `pos-totals`; the comparison
//      that follows is done with a `1e-9` absolute tolerance to
//      absorb the persistence-layer drift documented in
//      `sale-totals-identity.property.test.ts` (Prisma normalises
//      Decimal columns to ~13 significant decimals on the SQLite
//      TEXT round-trip, which is far below the cent-level
//      threshold of any genuine monetary bug).
//
//   6. Run the four reports against the per-test DB (the
//      `ReportService` reference is the dynamically-imported one
//      bound to the same singleton as `prisma`, courtesy of the
//      fixture's `vi.resetModules()` + `globalThis` slot delete) and
//      assert column-by-column equality with the reference. Order-
//      sensitive surfaces (`paymentBreakdown` cash → card → mobile;
//      `topSelling` units DESC then `productId` ASC; `lowStock`
//      reorderLevel DESC then onHand ASC then name ASC) are checked
//      as ordered arrays so a planner regression that loses the
//      stable ordering would surface immediately.
//
//   7. `numRuns: 30` is the convention used by every other DB-bound
//      property test in this folder (`sale-totals-identity`,
//      `tax-post-discount`). The per-iteration cost is high — each
//      iteration spawns `prisma migrate deploy` + `prisma db seed`
//      and finalises up to 8 sales — so 200 (the global default
//      from `tests/property/setup.ts`) would push the full property
//      tier well past anyone's patience. 30 still spans the
//      6-product × 0..8-sale × 1..3-line × 0..50%-discount ×
//      cash/card/mobile × 30-day-window search space comfortably.

import Decimal from 'decimal.js';
import * as fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  applyDiscount,
  computeGrandTotal,
  computeSubtotal,
  computeTaxTotal,
  type TotalsItem,
} from '@shared/pos-totals.js';

import { createTempDb } from '../integration/fixtures/temp-db.js';

import type {
  DailySalesPaymentBreakdownRow,
  DailySalesReport,
  DiscountInput,
  FinalizeSaleInput,
  LowStockRow,
  MonthlySalesReport,
  PaymentMethod,
  TopSellingRow,
} from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Persistence-layer Decimal tolerance — same `1e-9` bound used by
 * Property 2 / Property 8. Documented at length in
 * `sale-totals-identity.property.test.ts`: Prisma normalises Decimal
 * columns to ~13 significant decimals on the SQLite TEXT round-trip,
 * so a long fractional tail introduced by proportional-discount
 * tax allocation can drift by ~1e-14 once each column is read back
 * individually. `1e-9` absorbs that artifact while still surfacing
 * any genuine monetary bug, which is at least seven orders of
 * magnitude above this bound (every cent is `0.01`).
 */
const DECIMAL_TOLERANCE = new Decimal('1e-9');

/**
 * Fixed UTC anchor for the date window. Every workload's sales are
 * placed at `BASE_DATE + dayOffset` where `dayOffset` is a generated
 * integer in `[0, 30]`. Anchoring the base lets the deterministic
 * report windows (`dailySales(BASE_DATE)`, `monthlySales(BASE_MONTH)`,
 * `topSelling(BASE_DATE, BASE_DATE + 30d)`) be derived from a single
 * constant and keeps the reference / report comparison free of
 * clock drift across iterations.
 *
 * Day 1 of a month is chosen so the 30-day generated window sits
 * cleanly inside two adjacent calendar months — which exercises
 * `monthlySales`'s `[startOfMonth, startOfNextMonth)` boundary
 * (Req 9.2) without requiring the full window to fit inside a
 * single month.
 */
const BASE_YEAR = 2024;
/** Month index, 0-based — June 2024. */
const BASE_MONTH_INDEX = 5;
const BASE_DATE = new Date(Date.UTC(BASE_YEAR, BASE_MONTH_INDEX, 1));

/** Width of the generated date window in days. Sales land at
 *  `BASE_DATE + [0, MAX_DAY_OFFSET]` days plus an hour offset. */
const MAX_DAY_OFFSET = 30;

// ---------------------------------------------------------------------------
// Workload shape
// ---------------------------------------------------------------------------

/** Generated product with Decimal-string columns. */
interface WorkloadProduct {
  /** Per-unit sell price as a 2-decimal string (`'12.34'`). */
  readonly sellPrice: string;
  /** Tax rate as a Decimal-string (`'0'` | `'0.05'` | `'0.18'`). */
  readonly taxRate: string;
  /** Per-product reorder threshold in units. */
  readonly reorderLevel: number;
  /** Random extra units left over after every sale's demand is
   *  subtracted from `Inventory.onHand`. The final on-hand for a
   *  product is exactly `onHandBuffer`, so picking a buffer in
   *  `[0, 50]` and a `reorderLevel` in `[0, 30]` gives a meaningful
   *  mix of products above and below their threshold for the
   *  low-stock report. */
  readonly onHandBuffer: number;
}

/** Generated cart line — references a product by index. */
interface WorkloadLine {
  readonly productIndex: number;
  readonly quantity: number;
}

/** Generated discount input — same shape as the renderer's. */
type WorkloadDiscount =
  | { readonly kind: 'fixed'; readonly amountCents: number }
  | { readonly kind: 'percent'; readonly percentInt: number };

/** One generated sale. */
interface WorkloadSale {
  readonly lines: readonly WorkloadLine[];
  readonly discount: WorkloadDiscount;
  readonly method: PaymentMethod;
  /** UTC offset from `BASE_DATE` in whole days (`[0, MAX_DAY_OFFSET]`). */
  readonly dayOffset: number;
  /** UTC offset within the day, in whole hours (`[0, 23]`). */
  readonly hourOffset: number;
}

/** Top-level workload generated per fast-check iteration. */
interface Workload {
  readonly products: readonly WorkloadProduct[];
  readonly sales: readonly WorkloadSale[];
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Product arbitrary. `sellPrice` is generated as integer cents and
 * formatted to a 2-decimal string so every workload value is
 * representable exactly in `decimal.js` (no float drift on the
 * generator side). Tax rates are drawn from a small fixed set so
 * the tax-free fast-path (`computeTaxTotal`'s `taxRate.isZero()`
 * branch) is exercised alongside the proportional-allocation paths.
 */
const productArb: fc.Arbitrary<WorkloadProduct> = fc
  .record({
    sellPriceCents: fc.integer({ min: 100, max: 10_000 }),
    taxRate: fc.constantFrom('0', '0.05', '0.18'),
    reorderLevel: fc.integer({ min: 0, max: 30 }),
    onHandBuffer: fc.integer({ min: 0, max: 50 }),
  })
  .map(({ sellPriceCents, taxRate, reorderLevel, onHandBuffer }) => ({
    sellPrice: new Decimal(sellPriceCents).dividedBy(100).toFixed(2),
    taxRate,
    reorderLevel,
    onHandBuffer,
  }));

/**
 * Discount arbitrary. Mirrors the bounds used by Property 2 / 8 so
 * the generators stay consistent across the property tier.
 *
 *   - `fixed`   : 0.00..5.00 in whole cents.
 *   - `percent` : 0..50% in 1% increments.
 */
const discountArb: fc.Arbitrary<WorkloadDiscount> = fc.oneof(
  fc.record({
    kind: fc.constant('fixed' as const),
    amountCents: fc.integer({ min: 0, max: 500 }),
  }),
  fc.record({
    kind: fc.constant('percent' as const),
    percentInt: fc.integer({ min: 0, max: 50 }),
  }),
);

/**
 * Sale arbitrary parameterised on `productCount` so the generated
 * `productIndex` is always in range. fast-check's `chain` lets us
 * generate the products first and then the sales that reference
 * them by index, without producing an out-of-range index that
 * would surface as `FK_VIOLATION` at finalize time.
 */
function saleArb(productCount: number): fc.Arbitrary<WorkloadSale> {
  const lineArb: fc.Arbitrary<WorkloadLine> = fc.record({
    productIndex: fc.integer({ min: 0, max: productCount - 1 }),
    quantity: fc.integer({ min: 1, max: 3 }),
  });

  return fc.record({
    lines: fc.array(lineArb, { minLength: 1, maxLength: 3 }),
    discount: discountArb,
    method: fc.constantFrom<PaymentMethod>('cash', 'card', 'mobile'),
    dayOffset: fc.integer({ min: 0, max: MAX_DAY_OFFSET }),
    hourOffset: fc.integer({ min: 0, max: 23 }),
  });
}

/**
 * Top-level workload arbitrary. Generates 1..6 products first, then
 * 0..8 sales whose lines reference those products by index. Empty
 * sale arrays (no sales committed) are intentionally allowed so the
 * "empty window" code path in every report — `salesCount: 0`, `'0'`
 * money totals, empty `paymentBreakdown`, empty `topSelling.rows` —
 * is exercised.
 */
const workloadArb: fc.Arbitrary<Workload> = fc
  .array(productArb, { minLength: 1, maxLength: 6 })
  .chain((products) =>
    fc.record({
      products: fc.constant(products),
      sales: fc.array(saleArb(products.length), { minLength: 0, maxLength: 8 }),
    }),
  );

// ---------------------------------------------------------------------------
// Reference math (JS-only, no SQL)
// ---------------------------------------------------------------------------

/**
 * Per-sale totals computed from the workload via `pos-totals`. The
 * reference aggregator sums these in JS so the report assertions
 * compare SQL aggregates against the same numbers the SUT
 * persisted, but reached via an entirely separate code path
 * (in-memory `decimal.js` reduction).
 */
interface ResolvedSale {
  readonly subtotal: string;
  readonly discountAmount: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  readonly method: PaymentMethod;
  readonly createdAt: Date;
  /** Pre-discount, pre-tax `lineTotal` per line, in workload order.
   *  Used by the top-selling reference (Req 9.4) which sums
   *  `SaleItem.lineTotal` per product. */
  readonly perLine: readonly { productIndex: number; quantity: number; lineTotal: string }[];
}

/** Convert a generated discount into the wire `DiscountInput` shape. */
function toDiscountInput(d: WorkloadDiscount): DiscountInput {
  if (d.kind === 'fixed') {
    return { kind: 'fixed', amount: new Decimal(d.amountCents).dividedBy(100).toFixed(2) };
  }
  return { kind: 'percent', percent: new Decimal(d.percentInt).dividedBy(100).toFixed(2) };
}

/** Compute the UTC `Sale.createdAt` from the sale's day/hour offsets. */
function saleDate(sale: WorkloadSale): Date {
  const ms = BASE_DATE.getTime() + sale.dayOffset * 86_400_000 + sale.hourOffset * 3_600_000;
  return new Date(ms);
}

/**
 * Resolve every workload sale to its computed totals + per-line
 * decimals. Uses the SAME `pos-totals` math the SUT runs inside
 * its transaction, so the reference numbers are guaranteed to
 * agree with the persisted columns — Property 2 already verifies
 * that. Property 10 then asserts that the SQL aggregations over
 * those persisted columns equal the in-memory aggregations
 * computed here.
 */
function resolveSales(workload: Workload): readonly ResolvedSale[] {
  return workload.sales.map((sale) => {
    const items: readonly TotalsItem[] = sale.lines.map((line) => {
      const product = workload.products[line.productIndex];
      if (product === undefined) {
        throw new Error(`workload references missing productIndex ${line.productIndex}`);
      }
      return {
        quantity: line.quantity,
        unitPrice: product.sellPrice,
        taxRate: product.taxRate,
      };
    });
    const subtotal = computeSubtotal(items);
    const discountAmount = applyDiscount(subtotal, toDiscountInput(sale.discount));
    const taxTotal = computeTaxTotal(items, subtotal, discountAmount);
    const grandTotal = computeGrandTotal(subtotal, discountAmount, taxTotal);
    const perLine = sale.lines.map((line) => {
      const product = workload.products[line.productIndex];
      if (product === undefined) {
        throw new Error(`workload references missing productIndex ${line.productIndex}`);
      }
      return {
        productIndex: line.productIndex,
        quantity: line.quantity,
        lineTotal: new Decimal(product.sellPrice).mul(line.quantity).toString(),
      };
    });
    return {
      subtotal,
      discountAmount,
      taxTotal,
      grandTotal,
      method: sale.method,
      createdAt: saleDate(sale),
      perLine,
    };
  });
}

/** Stable ordering used by `dailySales.paymentBreakdown`. */
const PAYMENT_METHOD_ORDER: readonly PaymentMethod[] = ['cash', 'card', 'mobile'];

/**
 * Reference daily-sales aggregation over the resolved sales,
 * filtered to `[startOfDay, startOfNextDay)` UTC. Mirrors the
 * column projections and ordering the report service produces
 * (Req 9.1) so the assertion can be a structural deep-equal.
 */
function referenceDailySales(
  resolved: readonly ResolvedSale[],
  date: string,
): DailySalesReport {
  const start = parseUtcDate(date);
  const end = new Date(start.getTime() + 86_400_000);
  const inWindow = resolved.filter(
    (s) => s.createdAt.getTime() >= start.getTime() && s.createdAt.getTime() < end.getTime(),
  );

  let revenue = new Decimal(0);
  let tax = new Decimal(0);
  let discount = new Decimal(0);
  const sumByMethod = new Map<PaymentMethod, Decimal>();
  for (const s of inWindow) {
    revenue = revenue.plus(s.grandTotal);
    tax = tax.plus(s.taxTotal);
    discount = discount.plus(s.discountAmount);
    const prev = sumByMethod.get(s.method) ?? new Decimal(0);
    sumByMethod.set(s.method, prev.plus(s.grandTotal));
  }

  const paymentBreakdown: DailySalesPaymentBreakdownRow[] = [];
  for (const method of PAYMENT_METHOD_ORDER) {
    const total = sumByMethod.get(method);
    if (total === undefined) continue;
    paymentBreakdown.push({ method, amount: total.toString() });
  }

  return {
    date,
    salesCount: inWindow.length,
    totalRevenue: revenue.toString(),
    totalTax: tax.toString(),
    totalDiscount: discount.toString(),
    paymentBreakdown,
  };
}

/**
 * Reference monthly-sales aggregation over the resolved sales,
 * filtered to `[startOfMonth, startOfNextMonth)` UTC. Mirrors the
 * report service's monthly projection (Req 9.2).
 */
function referenceMonthlySales(
  resolved: readonly ResolvedSale[],
  month: string,
): MonthlySalesReport {
  const start = parseUtcMonth(month);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const inWindow = resolved.filter(
    (s) => s.createdAt.getTime() >= start.getTime() && s.createdAt.getTime() < end.getTime(),
  );

  let revenue = new Decimal(0);
  let tax = new Decimal(0);
  let discount = new Decimal(0);
  for (const s of inWindow) {
    revenue = revenue.plus(s.grandTotal);
    tax = tax.plus(s.taxTotal);
    discount = discount.plus(s.discountAmount);
  }

  return {
    month,
    salesCount: inWindow.length,
    totalRevenue: revenue.toString(),
    totalTax: tax.toString(),
    totalDiscount: discount.toString(),
  };
}

/**
 * Reference low-stock projection over the workload's products, after
 * applying every sale's per-product demand (final on-hand =
 * `onHandBuffer`). Filtered to `finalOnHand <= reorderLevel` and
 * ordered most-urgent first (`reorderLevel DESC, onHand ASC, name ASC`)
 * to match `InventoryService.lowStockList()` which the report
 * service forwards to (Req 9.3, 3.6).
 */
function referenceLowStock(
  products: readonly { sku: string; name: string; reorderLevel: number; finalOnHand: number; productId: string }[],
): readonly LowStockRow[] {
  const matched = products
    .filter((p) => p.finalOnHand <= p.reorderLevel)
    .map((p) => ({
      productId: p.productId,
      sku: p.sku,
      name: p.name,
      onHand: p.finalOnHand,
      reorderLevel: p.reorderLevel,
    }));
  matched.sort((a, b) => {
    if (a.reorderLevel !== b.reorderLevel) return b.reorderLevel - a.reorderLevel;
    if (a.onHand !== b.onHand) return a.onHand - b.onHand;
    return a.name.localeCompare(b.name);
  });
  return matched;
}

/**
 * Reference top-selling aggregation over the resolved sales,
 * filtered to `[dateFrom, dateTo + 1d)` UTC. Mirrors the
 * `prisma.saleItem.groupBy` shape the report service issues
 * (Req 9.4): per-product unit count and revenue (sum of
 * pre-discount, pre-tax `lineTotal`), filtered to `unitsSold > 0`,
 * ordered by `unitsSold DESC, productId ASC`.
 */
function referenceTopSelling(
  resolved: readonly ResolvedSale[],
  productIds: readonly string[],
  dateFrom: string,
  dateTo: string,
  productMeta: readonly { sku: string; name: string }[],
): readonly TopSellingRow[] {
  const start = parseUtcDate(dateFrom);
  const endInclusive = parseUtcDate(dateTo);
  const end = new Date(endInclusive.getTime() + 86_400_000);

  // Aggregate per productIndex.
  const unitsByIndex = new Map<number, number>();
  const revenueByIndex = new Map<number, Decimal>();
  for (const sale of resolved) {
    if (sale.createdAt.getTime() < start.getTime()) continue;
    if (sale.createdAt.getTime() >= end.getTime()) continue;
    for (const line of sale.perLine) {
      unitsByIndex.set(line.productIndex, (unitsByIndex.get(line.productIndex) ?? 0) + line.quantity);
      const prev = revenueByIndex.get(line.productIndex) ?? new Decimal(0);
      revenueByIndex.set(line.productIndex, prev.plus(line.lineTotal));
    }
  }

  const rows: TopSellingRow[] = [];
  for (let i = 0; i < productIds.length; i++) {
    const units = unitsByIndex.get(i) ?? 0;
    if (units <= 0) continue;
    const meta = productMeta[i];
    const productId = productIds[i];
    if (meta === undefined || productId === undefined) continue;
    rows.push({
      productId,
      sku: meta.sku,
      name: meta.name,
      unitsSold: units,
      revenue: (revenueByIndex.get(i) ?? new Decimal(0)).toString(),
    });
  }
  rows.sort((a, b) => {
    if (a.unitsSold !== b.unitsSold) return b.unitsSold - a.unitsSold;
    return a.productId.localeCompare(b.productId);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Date helpers (mirror `report.service.ts` semantics)
// ---------------------------------------------------------------------------

/** Parse `YYYY-MM-DD` as a UTC midnight `Date`. Throws on malformed input
 *  — the caller passes deterministic strings derived from `BASE_DATE`. */
function parseUtcDate(input: string): Date {
  const [y, m, d] = input.split('-').map((s) => Number.parseInt(s, 10));
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d)
  ) {
    throw new Error(`expected YYYY-MM-DD, got ${input}`);
  }
  return new Date(Date.UTC(y, m - 1, d));
}

/** Parse `YYYY-MM` as a UTC midnight `Date` on the 1st of the month. */
function parseUtcMonth(input: string): Date {
  const [y, m] = input.split('-').map((s) => Number.parseInt(s, 10));
  if (y === undefined || m === undefined || !Number.isFinite(y) || !Number.isFinite(m)) {
    throw new Error(`expected YYYY-MM, got ${input}`);
  }
  return new Date(Date.UTC(y, m - 1, 1));
}

/** Format a `Date` as `YYYY-MM-DD` (UTC). */
function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Format a `Date` as `YYYY-MM` (UTC). */
function formatUtcMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// Decimal-tolerant comparison helpers
// ---------------------------------------------------------------------------

/**
 * Assert two decimal strings are equal within `DECIMAL_TOLERANCE`.
 * Reports the offending label, both values, and the delta on
 * mismatch so a counterexample fingers the disagreeing column on
 * first inspection.
 */
function assertDecimalEqual(actual: string, expected: string, label: string): void {
  const a = new Decimal(actual);
  const b = new Decimal(expected);
  const delta = a.minus(b).abs();
  if (delta.greaterThan(DECIMAL_TOLERANCE)) {
    throw new Error(
      `[Property 10] ${label}: report value ${actual} ≠ reference ${expected} ` +
        `(|Δ|=${delta.toString()} > tolerance ${DECIMAL_TOLERANCE.toString()})`,
    );
  }
}

/** Assert two integers are equal; surfaces a clear label on mismatch. */
function assertIntEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`[Property 10] ${label}: report=${actual} reference=${expected}`);
  }
}

/** Assert two strings are equal verbatim (used for sku, name, productId). */
function assertStringEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`[Property 10] ${label}: report='${actual}' reference='${expected}'`);
  }
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Property 10 (report aggregates equal SQL aggregates) — ReportService', () => {
  it(
    "every report's values equal independently computed JS aggregates over the same workload",
    async () => {
      await fc.assert(
        fc.asyncProperty(workloadArb, async (workload) => {
          // Pre-iteration setup. Each fast-check run owns a fresh
          // SQLite — the fixture's `vi.resetModules()` +
          // `globalThis.__coreRetailErpPrisma` delete + dynamic
          // re-import of the service modules means `prisma`,
          // `POSService`, and `ReportService` all bind to the same
          // per-test client. `try/finally` guarantees cleanup runs
          // even on a failing assertion so the temp `.db` and its
          // sidecars are released back to the OS.
          const fixture = await createTempDb();
          try {
            // ---- Compute per-product demand & seed the catalog ---
            //
            // Pre-compute per-product demand across every sale so
            // `Inventory.onHand` can be sized to `demand + buffer`
            // — guaranteeing every finalize commits without an
            // OUT_OF_STOCK envelope, and leaving the buffer as the
            // FINAL on-hand value the low-stock report will
            // observe.
            const demand = new Array<number>(workload.products.length).fill(0);
            for (const sale of workload.sales) {
              for (const line of sale.lines) {
                const at = demand[line.productIndex];
                if (at === undefined) continue;
                demand[line.productIndex] = at + line.quantity;
              }
            }

            // Seed actor (Admin role pre-seeded by the fixture's
            // `prisma db seed`), supplier, category, and every
            // product. `sku` and `name` are deterministic per
            // workload index so the reference and the report both
            // agree on the joined columns the top-selling report
            // returns.
            const adminRole = await fixture.prisma.role.findUniqueOrThrow({
              where: { name: 'Admin' },
            });
            const actor = await fixture.prisma.user.create({
              data: {
                username: 'pbt-prop10-actor',
                passwordHash: 'pbt-not-a-real-hash',
                roleId: adminRole.id,
              },
            });
            const category = await fixture.prisma.category.create({
              data: { name: 'PBT-Prop10 Category' },
            });
            // Supplier seeded for completeness — the V1 report
            // surface does not include supplier history, but the
            // task description ("seed random sales / purchases /
            // customers / suppliers") points at the broader
            // Property 10 statement; keeping the row creation
            // here documents the intent and exercises FK
            // independence.
            await fixture.prisma.supplier.create({
              data: { name: 'PBT-Prop10 Supplier' },
            });

            const persistedProducts: { id: string; sku: string; name: string }[] = [];
            for (let i = 0; i < workload.products.length; i++) {
              const shape = workload.products[i];
              if (shape === undefined) continue;
              const sku = `PROP10-${i.toString().padStart(2, '0')}`;
              const name = `Prop10 Product ${i}`;
              const product = await fixture.prisma.product.create({
                data: {
                  sku,
                  name,
                  categoryId: category.id,
                  // `buyPrice` does not feed the V1 reports; mirror
                  // `sellPrice` so the row is self-consistent.
                  buyPrice: shape.sellPrice,
                  sellPrice: shape.sellPrice,
                  taxRate: shape.taxRate,
                  reorderLevel: shape.reorderLevel,
                },
              });
              const initialOnHand = (demand[i] ?? 0) + shape.onHandBuffer;
              await fixture.prisma.inventory.create({
                data: { productId: product.id, onHand: initialOnHand },
              });
              persistedProducts.push({ id: product.id, sku, name });
            }

            // ---- Resolve workload to per-sale totals ------------
            const resolved = resolveSales(workload);

            // ---- Drive every sale through finalizeSale ----------
            //
            // After each finalize, override `Sale.createdAt` to
            // the workload's chosen UTC timestamp via a direct
            // `prisma.sale.update`. The report's date predicates
            // are driven from this column; pinning it keeps the
            // assertion deterministic.
            for (let i = 0; i < workload.sales.length; i++) {
              const sale = workload.sales[i];
              if (sale === undefined) continue;
              const r = resolved[i];
              if (r === undefined) continue;

              const items = sale.lines.map((line) => {
                const product = persistedProducts[line.productIndex];
                const shape = workload.products[line.productIndex];
                if (product === undefined || shape === undefined) {
                  throw new Error(`sale ${i} references missing productIndex ${line.productIndex}`);
                }
                return {
                  productId: product.id,
                  quantity: line.quantity,
                  unitPrice: shape.sellPrice,
                  taxRate: shape.taxRate,
                  lineTotal: new Decimal(shape.sellPrice).mul(line.quantity).toString(),
                };
              });

              const input: FinalizeSaleInput = {
                customerId: null,
                items,
                discount: toDiscountInput(sale.discount),
                subtotal: r.subtotal,
                discountAmount: r.discountAmount,
                taxTotal: r.taxTotal,
                grandTotal: r.grandTotal,
                payments: [{ method: sale.method, amount: r.grandTotal }],
              };

              const result = await fixture.POSService.finalizeSale(input, {
                userId: actor.id,
              });
              if (!result.ok) {
                throw new Error(
                  `[Property 10] finalizeSale failed at sale ${i}: code=${result.error.code} ` +
                    `details=${JSON.stringify(result.error.details)} input=${JSON.stringify(input)}`,
                );
              }

              // Pin the persisted `createdAt` to the workload's
              // deterministic timestamp. The default is `now()`
              // which would scatter sales across the actual wall
              // clock and break the date-window assertions.
              await fixture.prisma.sale.update({
                where: { id: result.value.saleId },
                data: { createdAt: r.createdAt },
              });
            }

            // ---- Compute reference projections ------------------
            const dailyDateStr = formatUtcDate(BASE_DATE);
            const monthlyMonthStr = formatUtcMonth(BASE_DATE);
            const topFromStr = formatUtcDate(BASE_DATE);
            const topToStr = formatUtcDate(
              new Date(BASE_DATE.getTime() + MAX_DAY_OFFSET * 86_400_000),
            );

            const refDaily = referenceDailySales(resolved, dailyDateStr);
            const refMonthly = referenceMonthlySales(resolved, monthlyMonthStr);
            const refTop = referenceTopSelling(
              resolved,
              persistedProducts.map((p) => p.id),
              topFromStr,
              topToStr,
              persistedProducts.map((p) => ({ sku: p.sku, name: p.name })),
            );
            const refLowStock = referenceLowStock(
              workload.products.map((shape, i) => {
                const persisted = persistedProducts[i];
                if (persisted === undefined) {
                  throw new Error(`product index ${i} not persisted`);
                }
                return {
                  productId: persisted.id,
                  sku: persisted.sku,
                  name: persisted.name,
                  reorderLevel: shape.reorderLevel,
                  finalOnHand: shape.onHandBuffer,
                };
              }),
            );

            // ---- Run reports & assert agreement -----------------

            // Daily sales (Req 9.1).
            const dailyResult = await fixture.ReportService.dailySales({ date: dailyDateStr });
            if (!dailyResult.ok) {
              throw new Error(
                `[Property 10] dailySales returned Err: code=${dailyResult.error.code}`,
              );
            }
            const daily = dailyResult.value;
            assertStringEqual(daily.date, refDaily.date, 'dailySales.date');
            assertIntEqual(daily.salesCount, refDaily.salesCount, 'dailySales.salesCount');
            assertDecimalEqual(daily.totalRevenue, refDaily.totalRevenue, 'dailySales.totalRevenue');
            assertDecimalEqual(daily.totalTax, refDaily.totalTax, 'dailySales.totalTax');
            assertDecimalEqual(daily.totalDiscount, refDaily.totalDiscount, 'dailySales.totalDiscount');
            assertIntEqual(
              daily.paymentBreakdown.length,
              refDaily.paymentBreakdown.length,
              'dailySales.paymentBreakdown.length',
            );
            for (let i = 0; i < daily.paymentBreakdown.length; i++) {
              const got = daily.paymentBreakdown[i];
              const want = refDaily.paymentBreakdown[i];
              if (got === undefined || want === undefined) continue;
              assertStringEqual(got.method, want.method, `dailySales.paymentBreakdown[${i}].method`);
              assertDecimalEqual(
                got.amount,
                want.amount,
                `dailySales.paymentBreakdown[${i}].amount`,
              );
            }

            // Monthly sales (Req 9.2).
            const monthlyResult = await fixture.ReportService.monthlySales({
              month: monthlyMonthStr,
            });
            if (!monthlyResult.ok) {
              throw new Error(
                `[Property 10] monthlySales returned Err: code=${monthlyResult.error.code}`,
              );
            }
            const monthly = monthlyResult.value;
            assertStringEqual(monthly.month, refMonthly.month, 'monthlySales.month');
            assertIntEqual(monthly.salesCount, refMonthly.salesCount, 'monthlySales.salesCount');
            assertDecimalEqual(
              monthly.totalRevenue,
              refMonthly.totalRevenue,
              'monthlySales.totalRevenue',
            );
            assertDecimalEqual(monthly.totalTax, refMonthly.totalTax, 'monthlySales.totalTax');
            assertDecimalEqual(
              monthly.totalDiscount,
              refMonthly.totalDiscount,
              'monthlySales.totalDiscount',
            );

            // Low-stock summary (Req 9.3, 3.6).
            const lowStockResult = await fixture.ReportService.lowStockSummary();
            if (!lowStockResult.ok) {
              throw new Error(
                `[Property 10] lowStockSummary returned Err: code=${lowStockResult.error.code}`,
              );
            }
            const lowStock = lowStockResult.value.rows;
            assertIntEqual(lowStock.length, refLowStock.length, 'lowStockSummary.rows.length');
            for (let i = 0; i < lowStock.length; i++) {
              const got = lowStock[i];
              const want = refLowStock[i];
              if (got === undefined || want === undefined) continue;
              assertStringEqual(got.productId, want.productId, `lowStockSummary[${i}].productId`);
              assertStringEqual(got.sku, want.sku, `lowStockSummary[${i}].sku`);
              assertStringEqual(got.name, want.name, `lowStockSummary[${i}].name`);
              assertIntEqual(got.onHand, want.onHand, `lowStockSummary[${i}].onHand`);
              assertIntEqual(
                got.reorderLevel,
                want.reorderLevel,
                `lowStockSummary[${i}].reorderLevel`,
              );
            }

            // Top-selling (Req 9.4).
            const topResult = await fixture.ReportService.topSelling({
              dateFrom: topFromStr,
              dateTo: topToStr,
            });
            if (!topResult.ok) {
              throw new Error(
                `[Property 10] topSelling returned Err: code=${topResult.error.code}`,
              );
            }
            const top = topResult.value.rows;
            assertIntEqual(top.length, refTop.length, 'topSelling.rows.length');
            for (let i = 0; i < top.length; i++) {
              const got = top[i];
              const want = refTop[i];
              if (got === undefined || want === undefined) continue;
              assertStringEqual(got.productId, want.productId, `topSelling[${i}].productId`);
              assertStringEqual(got.sku, want.sku, `topSelling[${i}].sku`);
              assertStringEqual(got.name, want.name, `topSelling[${i}].name`);
              assertIntEqual(got.unitsSold, want.unitsSold, `topSelling[${i}].unitsSold`);
              assertDecimalEqual(got.revenue, want.revenue, `topSelling[${i}].revenue`);
            }
          } finally {
            await fixture.cleanup();
          }
        }),
        {
          // 30 iterations match the convention used by every other
          // DB-bound property test in this folder. Higher would
          // multiply the per-iteration cost (one fresh SQLite +
          // migrate + seed + N transactions + 4 reports) without
          // a proportionate coverage gain.
          numRuns: 30,
        },
      );
    },
    // Per-iteration cost: spinning up `prisma migrate deploy`
    // and `prisma db seed` is the dominant component (a few
    // seconds on Windows), times 30 iterations, plus per-iteration
    // sales finalize and report aggregation. Bump the per-test
    // timeout well above the 30s property-tier default so a
    // worst-case run fits comfortably; FAST_CHECK_SEED replay
    // makes any failing case reproducible regardless of the
    // headroom.
    600_000,
  );
});
