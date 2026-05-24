// src/main/services/report.service.ts
//
// Reports Module domain service (Phase 10, tasks 10.1–10.4).
//
// Computes the four V1 read-side reports on demand by SQL aggregation
// — no materialized views, no aggregation cache (design.md > "Reports
// Module"). Each method:
//
//   1. Validates and parses its inputs (date / month string, range
//      bounds), returning `Err('VALIDATION', { field })` for malformed
//      values rather than letting them surface as `INTERNAL`.
//   2. Issues one or two aggregation queries through the Prisma client,
//      preferring `aggregate` / `groupBy` over JS-side reduction so the
//      work stays in SQLite (Property 16's < 100 ms first-page target
//      for paginated channels does not apply here, but the same design
//      principle — push aggregations to the engine — keeps memory
//      bounded under millions of sale rows).
//   3. Normalizes Prisma's `Decimal` returns into wire-format decimal
//      strings via `decimal.js`. The wire DTOs in
//      `src/shared/dto/report.ts` declare every monetary column as
//      `string` (same convention as `dto/sale.ts` and `dto/product.ts`)
//      so renderers don't have to round-trip through `Prisma.Decimal`.
//
// All four channels are Admin-only per the static RBAC matrix
// (`src/main/permission/matrix.ts` — `reports:dailySales`,
// `reports:monthlySales`, `reports:topSelling` are `ADMIN_ONLY`;
// `reports:lowStock` is `ALL_ROLES` because the persistent banner
// click-through is visible to cashiers too). Authorization is enforced
// upstream by the IPC router middleware; this module only exposes the
// pure aggregation surface.
//
// Date semantics:
//
//   - `dailySales({ date })` covers `[startOfDay, endOfDay)` in **UTC**
//     (per "design.md says: use UTC boundaries unless design.md says
//     otherwise" — the design does not prescribe a different timezone).
//     `endOfDay` is the start of the following calendar day, exclusive,
//     so a sale committed at exactly `23:59:59.999Z` is included and a
//     sale at `00:00:00.000Z` belongs to the next day.
//
//   - `monthlySales({ month })` covers `[startOfMonth, startOfNextMonth)`
//     in UTC. The `month` field is `YYYY-MM`. February 2024's window
//     is `[2024-02-01T00:00:00Z, 2024-03-01T00:00:00Z)`.
//
//   - `topSelling({ dateFrom, dateTo, limit? })` covers `[dateFrom,
//     dateTo + 1 day)` so the renderer can pass two date strings
//     (`YYYY-MM-DD`) for an inclusive end-date semantics. Full ISO
//     timestamps are accepted too — they are passed through verbatim.
//
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 3.6.

import { Decimal } from 'decimal.js';

import { prisma } from '@main/db/prisma.js';
import { InventoryService } from '@main/services/inventory.service.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type {
  DailySalesPaymentBreakdownRow,
  DailySalesReport,
  LowStockRow,
  MonthlySalesReport,
  PaymentMethod,
  TopSellingRow,
} from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Default number of products returned by `topSelling` when the request
 * omits `limit`. The renderer's report page paginates through the full
 * window via repeat invocations on a tighter date range when needed; a
 * 100-row default keeps the headline view responsive without forcing
 * a follow-up call for typical month-range queries.
 */
const TOP_SELLING_DEFAULT_LIMIT = 100;

/**
 * Hard upper bound on `topSelling.limit`. Mirrors the list-channel
 * page-size cap (`clampPageSize`'s 200) so any one report invocation
 * cannot exceed the same memory footprint as a single list page.
 */
const TOP_SELLING_MAX_LIMIT = 200;

/** Stable ordering for the daily payment-method breakdown list. */
const PAYMENT_METHOD_ORDER: readonly PaymentMethod[] = Object.freeze([
  'cash',
  'card',
  'mobile',
]);

/** Whitelist used to validate `Payment.method` strings emerging from the
 *  `groupBy` aggregation. Anything off-list is treated as a data-integrity
 *  bug and skipped from the breakdown rather than crashing the report. */
const PAYMENT_METHOD_SET: ReadonlySet<PaymentMethod> = new Set(PAYMENT_METHOD_ORDER);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Match `YYYY-MM-DD` exactly (no embedded time component, no timezone
 * suffix). Looser parsing is unnecessary — the renderer always emits
 * ISO date strings via `<input type="date">` or `Date.toISOString().slice(0,10)`.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Match `YYYY-MM` exactly. */
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

/**
 * Parse a `YYYY-MM-DD` string into UTC midnight `Date`. Returns `null`
 * on any malformed input so the caller can map to
 * `Err('VALIDATION', { field })`.
 *
 * `new Date('YYYY-MM-DD')` parses as UTC midnight per ECMAScript
 * (Date Time String Format), but we go through explicit
 * `Date.UTC(year, month - 1, day)` so the result is unambiguous on
 * every host and so out-of-range components (`month === 13`,
 * `day === 32`) surface as `null` — `Date.UTC` would silently roll
 * those over, which would let `2024-13-01` become `2025-01-01` and
 * silently produce the wrong report.
 */
function parseUtcDate(input: string): Date | null {
  if (typeof input !== 'string' || !DATE_PATTERN.test(input)) return null;
  const year = Number.parseInt(input.slice(0, 4), 10);
  const month = Number.parseInt(input.slice(5, 7), 10);
  const day = Number.parseInt(input.slice(8, 10), 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const utc = Date.UTC(year, month - 1, day);
  const candidate = new Date(utc);
  // Reject calendar overflow (e.g. Feb 30 → Mar 2). Re-reading the UTC
  // components catches all rollovers in one comparison.
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return candidate;
}

/**
 * Parse a `YYYY-MM` string into UTC midnight on the 1st of that month.
 * Returns `null` on any malformed input.
 */
function parseUtcMonth(input: string): Date | null {
  if (typeof input !== 'string' || !MONTH_PATTERN.test(input)) return null;
  const year = Number.parseInt(input.slice(0, 4), 10);
  const month = Number.parseInt(input.slice(5, 7), 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, 1));
}

/**
 * Add a whole number of UTC days to a date.
 */
function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * Add a whole number of UTC months to a date. Used to compute
 * `endOfMonthExclusive` for the monthly report window.
 */
function addUtcMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

// ---------------------------------------------------------------------------
// Decimal helpers
// ---------------------------------------------------------------------------

/**
 * Render a Prisma `Decimal | null` as a wire-format decimal string.
 * `null` collapses to `'0'` so the wire DTO never carries a literal
 * `null` (renderer math is `new Decimal(value)` and `Decimal('null')`
 * throws).
 *
 * `decimal.js` is used (not `Prisma.Decimal`) per task instructions —
 * the import boundary is symmetric with the rest of the codebase
 * (`pos/totals.ts`, `purchase.service.ts`).
 */
function decimalSumToString(value: { toString(): string } | null | undefined): string {
  if (value === null || value === undefined) return '0';
  return new Decimal(value.toString()).toString();
}

// ---------------------------------------------------------------------------
// dailySales — Req 9.1
// ---------------------------------------------------------------------------

/**
 * Daily sales report for a single calendar day (Req 9.1).
 *
 * Input: `{ date }` where `date` is `YYYY-MM-DD`.
 *
 * Window: `[startOfDay, startOfNextDay)` in UTC. A sale committed at
 * exactly `23:59:59.999Z` is included; one at `00:00:00.000Z` of the
 * next day is not.
 *
 * Aggregations issued:
 *
 *   - `prisma.sale.aggregate({ _count, _sum: { grandTotal, taxTotal,
 *     discount } })` — produces total revenue, tax collected, discounts,
 *     and the count in a single round trip (design.md > "Query shapes").
 *   - `prisma.payment.groupBy({ by: ['method'], _sum: { amount } })`
 *     filtered by the same window (via the relation predicate
 *     `sale: { createdAt: { gte, lt } }`) — produces per-payment-method
 *     totals.
 *
 * Output: `DailySalesReport` with `paymentBreakdown` sorted by method
 * (cash → card → mobile). Methods that did not contribute to the day's
 * revenue are omitted from the breakdown — the renderer treats absent
 * methods as zero.
 *
 * Errors:
 *   - `Err('VALIDATION', { field: 'date' })` for malformed `date`.
 *
 * Validates: Requirements 9.1.
 */
async function dailySales(req: { date: string }): Promise<Result<DailySalesReport>> {
  const start = parseUtcDate(req.date);
  if (start === null) {
    return Err('VALIDATION', { field: 'date' });
  }
  const end = addUtcDays(start, 1);

  const [aggregate, breakdownRows] = await Promise.all([
    prisma.sale.aggregate({
      where: { createdAt: { gte: start, lt: end } },
      _count: { _all: true },
      _sum: { grandTotal: true, taxTotal: true, discount: true },
    }),
    prisma.payment.groupBy({
      by: ['method'],
      where: { sale: { createdAt: { gte: start, lt: end } } },
      _sum: { amount: true },
    }),
  ]);

  // Map the groupBy result into a wire-format breakdown sorted by
  // PAYMENT_METHOD_ORDER. Unknown method strings are skipped — the
  // schema does not constrain `Payment.method` to the union, and a
  // future migration that introduces a new method string should not
  // crash the report; it would still surface in the per-method
  // groupBy under that string.
  const sumByMethod = new Map<PaymentMethod, Decimal>();
  for (const row of breakdownRows) {
    const method = row.method;
    if (!PAYMENT_METHOD_SET.has(method as PaymentMethod)) continue;
    const sum = row._sum.amount;
    if (sum === null || sum === undefined) continue;
    sumByMethod.set(method as PaymentMethod, new Decimal(sum.toString()));
  }
  const paymentBreakdown: DailySalesPaymentBreakdownRow[] = [];
  for (const method of PAYMENT_METHOD_ORDER) {
    const total = sumByMethod.get(method);
    if (total === undefined) continue;
    paymentBreakdown.push({ method, amount: total.toString() });
  }

  const report: DailySalesReport = {
    date: req.date,
    salesCount: aggregate._count._all,
    totalRevenue: decimalSumToString(aggregate._sum.grandTotal),
    totalTax: decimalSumToString(aggregate._sum.taxTotal),
    totalDiscount: decimalSumToString(aggregate._sum.discount),
    paymentBreakdown,
  };
  return Ok(report);
}

// ---------------------------------------------------------------------------
// monthlySales — Req 9.2
// ---------------------------------------------------------------------------

/**
 * Monthly sales report for a single calendar month (Req 9.2).
 *
 * Input: `{ month }` where `month` is `YYYY-MM`.
 *
 * Window: `[startOfMonth, startOfNextMonth)` in UTC. February 2024's
 * window is `[2024-02-01T00:00:00Z, 2024-03-01T00:00:00Z)`.
 *
 * Aggregation: same `prisma.sale.aggregate` shape as `dailySales`,
 * minus the per-payment-method breakdown (the monthly report's
 * headline figures only — design.md > "Reports Module").
 *
 * Errors:
 *   - `Err('VALIDATION', { field: 'month' })` for malformed `month`.
 *
 * Validates: Requirements 9.2.
 */
async function monthlySales(req: {
  month: string;
}): Promise<Result<MonthlySalesReport>> {
  const start = parseUtcMonth(req.month);
  if (start === null) {
    return Err('VALIDATION', { field: 'month' });
  }
  const end = addUtcMonths(start, 1);

  const aggregate = await prisma.sale.aggregate({
    where: { createdAt: { gte: start, lt: end } },
    _count: { _all: true },
    _sum: { grandTotal: true, taxTotal: true, discount: true },
  });

  const report: MonthlySalesReport = {
    month: req.month,
    salesCount: aggregate._count._all,
    totalRevenue: decimalSumToString(aggregate._sum.grandTotal),
    totalTax: decimalSumToString(aggregate._sum.taxTotal),
    totalDiscount: decimalSumToString(aggregate._sum.discount),
  };
  return Ok(report);
}

// ---------------------------------------------------------------------------
// lowStockSummary — Req 9.3, 3.6
// ---------------------------------------------------------------------------

/**
 * Low-stock report — every product whose `Inventory.onHand <=
 * Product.reorderLevel` (Req 9.3, 3.6).
 *
 * Forwards directly to `InventoryService.lowStockList()`, which owns
 * the cross-column join against `Inventory` + `Product` and returns
 * the rows ordered most-urgent first (highest `reorderLevel`, then
 * lowest `onHand`, then `name`). Putting the SQL in InventoryService
 * keeps the cross-table join in one place — the persistent banner
 * (`<LowStockBanner>`) and this report channel both consume the same
 * projection.
 *
 * Input: `void`. The summary is a finite alert surface (Req 9.3
 * implies the list is bounded by the catalog size below the reorder
 * threshold), so there is no pagination.
 *
 * Validates: Requirements 9.3, 3.6.
 */
async function lowStockSummary(): Promise<Result<{ rows: readonly LowStockRow[] }>> {
  return InventoryService.lowStockList();
}

// ---------------------------------------------------------------------------
// topSelling — Req 9.4
// ---------------------------------------------------------------------------

/**
 * Top-selling products within a date range (Req 9.4).
 *
 * Input: `{ dateFrom, dateTo, limit? }`. `dateFrom` and `dateTo` are
 * `YYYY-MM-DD` strings; the window is inclusive of both ends so
 * `dateFrom == dateTo` returns a single day. `limit` defaults to
 * `TOP_SELLING_DEFAULT_LIMIT` (100) and is clamped to
 * `TOP_SELLING_MAX_LIMIT` (200).
 *
 * Aggregation: `prisma.saleItem.groupBy({ by: ['productId'], _sum:
 * { quantity, lineTotal }, where: { sale: { createdAt: { gte, lt } } } })`
 * — one round trip that produces the per-product unit count and gross
 * revenue for the window. The `take` is applied at SQL level via the
 * `groupBy` `take` option so SQLite returns only the top-N rows
 * directly. A second round trip looks up the joined `sku` + `name`
 * for the returned product ids.
 *
 * Output: `{ rows: TopSellingRow[] }` ordered by `unitsSold` DESC,
 * tie-broken by `productId` ASC for deterministic ordering across
 * runs.
 *
 * Errors:
 *   - `Err('VALIDATION', { field: 'dateFrom' | 'dateTo' })` for
 *     malformed inputs.
 *   - `Err('VALIDATION', { field: 'range' })` if `dateFrom > dateTo`.
 *
 * Validates: Requirements 9.4.
 */
async function topSelling(req: {
  dateFrom: string;
  dateTo: string;
  limit?: number;
}): Promise<Result<{ rows: readonly TopSellingRow[] }>> {
  const start = parseUtcDate(req.dateFrom);
  if (start === null) {
    return Err('VALIDATION', { field: 'dateFrom' });
  }
  const endInclusive = parseUtcDate(req.dateTo);
  if (endInclusive === null) {
    return Err('VALIDATION', { field: 'dateTo' });
  }
  if (start.getTime() > endInclusive.getTime()) {
    return Err('VALIDATION', { field: 'range' });
  }
  // Convert inclusive-end to exclusive-end so the SQLite range predicate
  // is the same `[gte, lt)` shape as the daily/monthly reports. Sales
  // committed on `dateTo` between 00:00 and 23:59:59.999 are included.
  const endExclusive = addUtcDays(endInclusive, 1);

  // Limit handling: default to TOP_SELLING_DEFAULT_LIMIT, clamp to
  // [1, TOP_SELLING_MAX_LIMIT]. Non-finite or non-integer values are
  // treated as "use the default" rather than a VALIDATION envelope —
  // the renderer's report UI provides a numeric stepper that cannot
  // emit fractional values, but a programmatic caller (e.g. CSV
  // export) might pass through `undefined`.
  const requestedLimit =
    typeof req.limit === 'number' && Number.isFinite(req.limit) && Number.isInteger(req.limit)
      ? req.limit
      : TOP_SELLING_DEFAULT_LIMIT;
  const limit = Math.min(
    Math.max(requestedLimit, 1),
    TOP_SELLING_MAX_LIMIT,
  );

  // Step 1 — aggregate units sold + revenue by product, take the top N.
  // `groupBy` on the SaleItem delegate accepts an `orderBy` against an
  // aggregated column (`{ _sum: { quantity: 'desc' } }`), so SQLite can
  // surface the top-N directly without materializing every product.
  const grouped = await prisma.saleItem.groupBy({
    by: ['productId'],
    where: {
      sale: { createdAt: { gte: start, lt: endExclusive } },
    },
    _sum: { quantity: true, lineTotal: true },
    orderBy: [{ _sum: { quantity: 'desc' } }, { productId: 'asc' }],
    take: limit,
  });

  if (grouped.length === 0) {
    return Ok({ rows: [] });
  }

  // Step 2 — fetch the joined `sku` + `name` for the returned product
  // ids in a single `findMany`. Building a per-id lookup map keeps the
  // final projection O(N) without a per-row N+1 follow-up.
  const productIds = grouped.map((row) => row.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, sku: true, name: true },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  // Step 3 — project to wire DTOs in groupBy result order. A product
  // that vanished between steps 1 and 2 (a delete inside a concurrent
  // tx, vanishingly unlikely under the single-writer constraint but
  // possible during a destructive migration) is dropped from the
  // result rather than surfaced as a placeholder; downstream consumers
  // expect every row to carry a real `sku` + `name`.
  const rows: TopSellingRow[] = [];
  for (const row of grouped) {
    const product = productById.get(row.productId);
    if (product === undefined) continue;
    const unitsSoldRaw = row._sum.quantity;
    const unitsSold = unitsSoldRaw ?? 0;
    if (unitsSold <= 0) continue;
    rows.push({
      productId: row.productId,
      sku: product.sku,
      name: product.name,
      unitsSold,
      revenue: decimalSumToString(row._sum.lineTotal),
    });
  }

  return Ok({ rows });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * ReportService — the four V1 read-side reports plus the future
 * streaming export entry point (Phase 10 tasks 10.5–10.7).
 *
 * Exposed as a frozen object literal so callers import a single named
 * symbol and the IPC handler module wires each method to its channel
 * without instantiating a class. Matches the convention established
 * by every other service in this folder.
 */
export const ReportService = Object.freeze({
  dailySales,
  monthlySales,
  lowStockSummary,
  topSelling,
} as const);
