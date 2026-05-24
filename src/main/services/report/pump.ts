// src/main/services/report/pump.ts
//
// Shared cursor pump for streaming report exports (Phase 10, tasks
// 10.5–10.7).
//
// The four V1 reports each have a different underlying table:
//
//   - `dailySales` / `monthlySales` → row-level export pulls from
//     `Sale` joined with `User` (cashier name) and `Customer`
//     (customer name); each row is one finalized sale.
//   - `lowStock`                      → row-level export pulls from
//     the `LowStockRow` projection that backs the existing report.
//   - `topSelling`                    → row-level export pulls from
//     the same `TopSellingRow` projection the read-side channel
//     produces.
//
// `pumpRows` is the single helper every encoder (CSV, PDF) calls to
// drive batches through. Behaviour:
//
//   - For paginated reports (`dailySales`, `monthlySales`) the pump
//     drives `paginateCursor` against `Sale` ordered by
//     `(createdAt DESC, id)` — same composite index every other
//     time-typed list channel uses, so the SQLite planner resolves
//     each batch as an indexed seek + bounded scan and memory stays
//     bounded by `pageSize` rows (Property 17 / Req 16.6).
//   - For non-paginated reports (`lowStock`, `topSelling`) the pump
//     fetches once via the existing `ReportService` methods and
//     emits the result as a single batch. These projections are
//     bounded by the catalog size and the requested `limit`
//     respectively, so the same memory budget applies without
//     splitting the query.
//
// `pumpRows` is generic on the row shape so each encoder receives a
// well-typed batch. The helper resolves with `{ rowCount }` after
// every batch has been delivered to its consumer; encoders are
// responsible for awaiting their own `finish` events before
// reporting completion to the IPC handler.
//
// Validates: Requirements 9.5, 16.3, 16.6.

import { paginateCursor } from '@main/db/paginate.js';
import { prisma } from '@main/db/prisma.js';
import { ReportService } from '@main/services/report.service.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type { Prisma } from '@prisma/client';
import type {
  LowStockRow,
  ReportExportRequest,
  TopSellingRow,
} from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Row shapes — one per `reportId`
// ---------------------------------------------------------------------------

/**
 * One row of the `dailySales` / `monthlySales` row-level export.
 * Mirrors a finalized sale: serial number, ISO timestamp, cashier,
 * optional customer, and the four monetary columns. Money fields are
 * decimal strings so the wire format is round-trip-safe with
 * `Prisma.Decimal` (same convention as every other DTO).
 */
export interface SalesExportRow {
  readonly serialNo: string;
  readonly createdAt: string;
  readonly cashier: string;
  readonly customer: string;
  readonly subtotal: string;
  readonly discount: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
}

/**
 * Discriminated union covering every row shape any of the four
 * reports produces. Encoders branch on the discriminator (or simply
 * project keys via `Object.keys` — the CSV encoder takes the latter
 * route) so a future report type only needs a new entry here.
 */
export type ExportRow = SalesExportRow | LowStockRow | TopSellingRow;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Batch consumer signature. Called once per batch; receives the
 * batch index (zero-based; `0` means "this is the first batch", used
 * by the CSV encoder to decide whether to emit the header row), the
 * batch contents, and a flag indicating whether this is the last
 * batch.
 *
 * Consumers are awaited sequentially so backpressure on the
 * downstream stream is honored — a slow disk does not let the pump
 * race ahead and accumulate in-memory rows.
 */
export type BatchConsumer<TRow> = (
  batch: readonly TRow[],
  meta: { readonly batchIndex: number; readonly isLast: boolean },
) => Promise<void>;

/**
 * Default batch size for cursor-paginated pumps. Mirrors the list
 * channel default in `clampPageSize` (Req 16.1) so memory bounds are
 * consistent across the read-side surface.
 */
export const DEFAULT_PAGE_SIZE = 200;

/**
 * Column descriptor used by the CSV / PDF encoders so the column
 * order on disk matches across both formats. The `key` lookups
 * against the row record drive the encoder; the `header` is the
 * first-row label (CSV) or column heading (PDF).
 */
export interface ExportColumn<TRow> {
  readonly key: keyof TRow & string;
  readonly header: string;
}

/**
 * Per-report metadata. Encoders use the `title` for the PDF heading,
 * the `columns` for ordering and projection, and the row union for
 * compile-time exhaustiveness on the discriminator.
 */
export interface ReportShape<TRow> {
  readonly reportId: ReportExportRequest['reportId'];
  readonly title: string;
  readonly columns: readonly ExportColumn<TRow>[];
}

/**
 * Static per-report shapes. Frozen so consumers cannot mutate the
 * column order at runtime. Order matters — both encoders write
 * columns in the order declared here.
 */
export const SALES_EXPORT_COLUMNS: readonly ExportColumn<SalesExportRow>[] = Object.freeze([
  Object.freeze({ key: 'serialNo', header: 'Serial' }),
  Object.freeze({ key: 'createdAt', header: 'Date' }),
  Object.freeze({ key: 'cashier', header: 'Cashier' }),
  Object.freeze({ key: 'customer', header: 'Customer' }),
  Object.freeze({ key: 'subtotal', header: 'Subtotal' }),
  Object.freeze({ key: 'discount', header: 'Discount' }),
  Object.freeze({ key: 'taxTotal', header: 'Tax' }),
  Object.freeze({ key: 'grandTotal', header: 'Grand Total' }),
]);

export const LOW_STOCK_EXPORT_COLUMNS: readonly ExportColumn<LowStockRow>[] = Object.freeze([
  Object.freeze({ key: 'sku', header: 'SKU' }),
  Object.freeze({ key: 'name', header: 'Product' }),
  Object.freeze({ key: 'onHand', header: 'On Hand' }),
  Object.freeze({ key: 'reorderLevel', header: 'Reorder Level' }),
]);

export const TOP_SELLING_EXPORT_COLUMNS: readonly ExportColumn<TopSellingRow>[] = Object.freeze([
  Object.freeze({ key: 'sku', header: 'SKU' }),
  Object.freeze({ key: 'name', header: 'Product' }),
  Object.freeze({ key: 'unitsSold', header: 'Units Sold' }),
  Object.freeze({ key: 'revenue', header: 'Revenue' }),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the `reportId` from a request and return its column shape
 * + DOM title, plus a runtime tag the encoders branch on. The tag is
 * a string-literal-typed discriminator distinct from the rendered
 * row shape so encoders can use it inside `switch`-on-tag without
 * `instanceof`.
 */
export function describeReport(reportId: ReportExportRequest['reportId']): {
  readonly title: string;
  readonly columns: readonly ExportColumn<ExportRow>[];
} {
  switch (reportId) {
    case 'dailySales':
      return {
        title: 'Daily Sales',
        columns: SALES_EXPORT_COLUMNS as unknown as readonly ExportColumn<ExportRow>[],
      };
    case 'monthlySales':
      return {
        title: 'Monthly Sales',
        columns: SALES_EXPORT_COLUMNS as unknown as readonly ExportColumn<ExportRow>[],
      };
    case 'lowStock':
      return {
        title: 'Low Stock',
        columns: LOW_STOCK_EXPORT_COLUMNS as unknown as readonly ExportColumn<ExportRow>[],
      };
    case 'topSelling':
      return {
        title: 'Top Selling',
        columns: TOP_SELLING_EXPORT_COLUMNS as unknown as readonly ExportColumn<ExportRow>[],
      };
    /* c8 ignore next 2 */
    default:
      throw new Error(`Unknown reportId: ${reportId as string}`);
  }
}

// ---------------------------------------------------------------------------
// pumpRows — drive the cursor and feed each batch into the consumer
// ---------------------------------------------------------------------------

/**
 * Top-level pump options. `pageSize` is clamped by the underlying
 * `paginateCursor` for sales-driven reports; non-paginated reports
 * ignore it.
 */
export interface PumpOptions {
  readonly request: ReportExportRequest;
  /** Optional override for the per-batch row count. Defaults to
   *  {@link DEFAULT_PAGE_SIZE}. */
  readonly pageSize?: number;
}

/**
 * Pump rows for `request.reportId` through `consumer`. Returns
 * `Ok({ rowCount })` after every batch has been delivered, or `Err`
 * if validation (e.g. a malformed `dateFrom`) or an underlying
 * paginator error fires.
 *
 * The pump is generic on the row shape so encoders can declare
 * specific consumer signatures. Internally the pump uses the
 * `ExportRow` union and `consumer` is invoked with a typed batch
 * for that union — encoders narrow at the call site by the
 * `reportId` they were configured with.
 */
export async function pumpRows(
  options: PumpOptions,
  consumer: BatchConsumer<ExportRow>,
): Promise<Result<{ rowCount: number }>> {
  const { request, pageSize = DEFAULT_PAGE_SIZE } = options;

  switch (request.reportId) {
    case 'dailySales':
    case 'monthlySales':
      return pumpSales(request, pageSize, consumer);

    case 'lowStock':
      return pumpLowStock(consumer);

    case 'topSelling':
      return pumpTopSelling(request, consumer);

    /* c8 ignore next 2 */
    default:
      return Err('VALIDATION', { field: 'reportId' });
  }
}

// ---------------------------------------------------------------------------
// Sales pump (dailySales / monthlySales row-level export)
// ---------------------------------------------------------------------------

/**
 * Compile the `dailySales` / `monthlySales` window into a Prisma
 * `where` shape on `Sale.createdAt`. Reuses the same date-validation
 * shape as `ReportService.dailySales` / `monthlySales`: `YYYY-MM-DD`
 * for daily, `YYYY-MM` for monthly. Malformed inputs surface as
 * `Err('VALIDATION', { field })`.
 *
 * When `request.filter` is missing we still run the export — the
 * sales export "all sales" mode is the unfiltered case used by
 * Property 17's memory-bound test (the test fixture seeds 1M rows
 * and then runs `reports:export` against the unbounded set).
 */
function compileSalesWhere(
  request: ReportExportRequest,
): { ok: true; where: Prisma.SaleWhereInput | undefined } | { ok: false; field: string } {
  const filter = request.filter as
    | { date?: string; month?: string; dateFrom?: string; dateTo?: string }
    | undefined;
  if (filter === undefined) {
    return { ok: true, where: undefined };
  }

  // Daily-sales path expects `{ date: 'YYYY-MM-DD' }`.
  if (request.reportId === 'dailySales' && typeof filter.date === 'string') {
    const start = parseUtcDate(filter.date);
    if (start === null) return { ok: false, field: 'date' };
    const end = addUtcDays(start, 1);
    return { ok: true, where: { createdAt: { gte: start, lt: end } } };
  }

  // Monthly-sales path expects `{ month: 'YYYY-MM' }`.
  if (request.reportId === 'monthlySales' && typeof filter.month === 'string') {
    const start = parseUtcMonth(filter.month);
    if (start === null) return { ok: false, field: 'month' };
    const end = addUtcMonths(start, 1);
    return { ok: true, where: { createdAt: { gte: start, lt: end } } };
  }

  // Free-form `[dateFrom, dateTo]` — the topSelling-style range so the
  // renderer can drive a custom export over an arbitrary window.
  if (typeof filter.dateFrom === 'string' || typeof filter.dateTo === 'string') {
    const start =
      typeof filter.dateFrom === 'string' ? parseUtcDate(filter.dateFrom) : null;
    const endInclusive =
      typeof filter.dateTo === 'string' ? parseUtcDate(filter.dateTo) : null;
    if (typeof filter.dateFrom === 'string' && start === null) {
      return { ok: false, field: 'dateFrom' };
    }
    if (typeof filter.dateTo === 'string' && endInclusive === null) {
      return { ok: false, field: 'dateTo' };
    }
    const where: Prisma.SaleWhereInput = {};
    if (start !== null && endInclusive !== null) {
      where.createdAt = { gte: start, lt: addUtcDays(endInclusive, 1) };
    } else if (start !== null) {
      where.createdAt = { gte: start };
    } else if (endInclusive !== null) {
      where.createdAt = { lt: addUtcDays(endInclusive, 1) };
    }
    return { ok: true, where };
  }

  return { ok: true, where: undefined };
}

/**
 * Drive the `Sale` table through `paginateCursor`, projecting each
 * row into the wire-format `SalesExportRow` shape and feeding
 * batches into `consumer`. The Prisma `findMany` call is wrapped so
 * the structural `PaginateModel` interface is satisfied without a
 * widened argument type.
 */
async function pumpSales(
  request: ReportExportRequest,
  pageSize: number,
  consumer: BatchConsumer<ExportRow>,
): Promise<Result<{ rowCount: number }>> {
  const compiled = compileSalesWhere(request);
  if (!compiled.ok) {
    return Err('VALIDATION', { field: compiled.field });
  }

  // Wrap `prisma.sale` so the helper sees a `findMany` that returns
  // rows with relations attached. We deliberately do not pass a
  // `count` here because the export pump is single-pass and the
  // rowCount comes from the running tally rather than a separate
  // COUNT(*).
  const model = makeSaleExportModel(compiled.where);

  let rowCount = 0;
  let cursor: string | undefined;
  let batchIndex = 0;
  while (true) {
    const page = await paginateCursor({
      model,
      sortColumn: 'createdAt',
      ...(compiled.where !== undefined ? { where: compiled.where } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      pageSize,
    });
    if (!page.ok) {
      return page;
    }
    const rows = page.value.rows.map(projectSaleRow);
    const isLast = page.value.nextCursor === null;
    await consumer(rows, { batchIndex, isLast });
    rowCount += rows.length;
    batchIndex += 1;
    if (isLast) break;
    cursor = page.value.nextCursor ?? undefined;
  }
  return Ok({ rowCount });
}

/** Row shape `findMany` returns once the `cashier` + `customer`
 *  relations are joined. */
type SaleRowWithRelations = Prisma.SaleGetPayload<{
  include: {
    cashier: { select: { username: true } };
    customer: { select: { name: true } };
  };
}>;

/**
 * Wrap `prisma.sale` so it satisfies the structural
 * `PaginateModel<SaleRowWithRelations>` shape — the helper's
 * `findMany` is invoked with `{ where, orderBy, take }` and we add
 * the `include` clause that pulls the join columns onto every row.
 */
function makeSaleExportModel(where: Prisma.SaleWhereInput | undefined): {
  findMany(args: {
    where?: Record<string, unknown>;
    orderBy: readonly Record<string, 'asc' | 'desc'>[];
    take: number;
  }): Promise<SaleRowWithRelations[]>;
} {
  return {
    findMany(args) {
      const findArgs: Prisma.SaleFindManyArgs = {
        ...(args.where !== undefined
          ? { where: args.where }
          : where !== undefined
            ? { where }
            : {}),
        orderBy: args.orderBy.map((entry) => ({ ...entry })),
        take: args.take,
        include: {
          cashier: { select: { username: true } },
          customer: { select: { name: true } },
        },
      };
      return prisma.sale.findMany(findArgs) as unknown as Promise<SaleRowWithRelations[]>;
    },
  };
}

/** Project a Prisma `Sale` row (with cashier + customer joined) into
 *  the wire-format `SalesExportRow` shape. Decimals are stringified
 *  via `toString()` to keep the wire format round-trip-safe. */
function projectSaleRow(row: SaleRowWithRelations): SalesExportRow {
  return {
    serialNo: row.serialNo,
    createdAt: row.createdAt.toISOString(),
    cashier: row.cashier.username,
    customer: row.customer?.name ?? '',
    subtotal: row.subtotal.toString(),
    discount: row.discount.toString(),
    taxTotal: row.taxTotal.toString(),
    grandTotal: row.grandTotal.toString(),
  };
}

// ---------------------------------------------------------------------------
// Low-stock and top-selling pumps (single-batch)
// ---------------------------------------------------------------------------

async function pumpLowStock(
  consumer: BatchConsumer<ExportRow>,
): Promise<Result<{ rowCount: number }>> {
  const result = await ReportService.lowStockSummary();
  if (!result.ok) return result;
  const rows = [...result.value.rows];
  await consumer(rows, { batchIndex: 0, isLast: true });
  return Ok({ rowCount: rows.length });
}

async function pumpTopSelling(
  request: ReportExportRequest,
  consumer: BatchConsumer<ExportRow>,
): Promise<Result<{ rowCount: number }>> {
  const filter = request.filter as
    | { dateFrom?: string; dateTo?: string; limit?: number }
    | undefined;
  if (filter === undefined) {
    return Err('VALIDATION', { field: 'filter' });
  }
  if (typeof filter.dateFrom !== 'string' || typeof filter.dateTo !== 'string') {
    return Err('VALIDATION', { field: 'dateFrom' });
  }
  const result = await ReportService.topSelling({
    dateFrom: filter.dateFrom,
    dateTo: filter.dateTo,
    ...(typeof filter.limit === 'number' ? { limit: filter.limit } : {}),
  });
  if (!result.ok) return result;
  const rows = [...result.value.rows];
  await consumer(rows, { batchIndex: 0, isLast: true });
  return Ok({ rowCount: rows.length });
}

// ---------------------------------------------------------------------------
// Date helpers (mirrored from report.service.ts so this module stays
// dependency-free from the service-level validation surface)
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

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
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return candidate;
}

function parseUtcMonth(input: string): Date | null {
  if (typeof input !== 'string' || !MONTH_PATTERN.test(input)) return null;
  const year = Number.parseInt(input.slice(0, 4), 10);
  const month = Number.parseInt(input.slice(5, 7), 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, 1));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addUtcMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}
