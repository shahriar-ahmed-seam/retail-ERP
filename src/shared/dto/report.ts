/**
 * Reports Module DTOs (Phase 10, tasks 10.1–10.4).
 *
 * Cross-process types for the four V1 report channels:
 *
 *   - `reports:dailySales`   → DailySalesReport   (Req 9.1)
 *   - `reports:monthlySales` → MonthlySalesReport (Req 9.2)
 *   - `reports:lowStock`     → { rows: LowStockRow[] }    (Req 9.3, 3.6)
 *   - `reports:topSelling`   → { rows: TopSellingRow[] }  (Req 9.4)
 *
 * Money columns are decimal strings end-to-end so the wire format is
 * round-trip-safe with `Prisma.Decimal` (same convention as
 * `dto/sale.ts` and `dto/product.ts`). The renderer is responsible for
 * formatting locale / currency at display time.
 *
 * Field names follow the IPC contract that has been live since Phase 2
 * (`totalRevenue` / `totalTax` / `totalDiscount` rather than
 * `revenue` / `taxTotal` / `discountTotal`) so the renderer surface
 * declared in `src/shared/ipc-contract.ts` does not need to change as
 * task 10.x lands.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 3.6.
 */

import type { PaymentMethod } from './sale.js';

// ---------------------------------------------------------------------------
// Daily sales (Req 9.1)
// ---------------------------------------------------------------------------

/**
 * Per-payment-method breakdown row inside `DailySalesReport`. Only
 * methods that actually contributed to the day's revenue appear in the
 * list, sorted by method name (`'cash' < 'card' < 'mobile'`) so the
 * renderer can render them deterministically.
 */
export interface DailySalesPaymentBreakdownRow {
  readonly method: PaymentMethod;
  /** Sum of `Payment.amount` for the day, decimal-as-string. */
  readonly amount: string;
}

/**
 * Result shape of `reports:dailySales`. Every monetary field is the sum
 * of the matching `Sale` column inside the requested day's `[startOfDay,
 * endOfDay)` UTC window. Empty days (no sales committed) surface
 * `salesCount: 0`, money fields as `'0'`, and an empty
 * `paymentBreakdown` array.
 */
export interface DailySalesReport {
  /** Echo of the request's `date` (YYYY-MM-DD). */
  readonly date: string;
  /** `COUNT(*)` of `Sale` rows in the window. */
  readonly salesCount: number;
  /** `SUM(Sale.grandTotal)` as a decimal string. */
  readonly totalRevenue: string;
  /** `SUM(Sale.taxTotal)` as a decimal string. */
  readonly totalTax: string;
  /** `SUM(Sale.discount)` as a decimal string. */
  readonly totalDiscount: string;
  /** One row per payment method that contributed to the day's revenue. */
  readonly paymentBreakdown: readonly DailySalesPaymentBreakdownRow[];
}

// ---------------------------------------------------------------------------
// Monthly sales (Req 9.2)
// ---------------------------------------------------------------------------

/**
 * Result shape of `reports:monthlySales`. The window is the full
 * calendar month identified by the request's `month` field
 * (`YYYY-MM`), aligned to UTC midnight on the 1st of the month and
 * covering through the first millisecond of the following month
 * (`[startOfMonth, startOfNextMonth)`).
 *
 * No payment breakdown — month-level reports are headline figures
 * only; per-method totals for a month can be rolled up by the renderer
 * from the per-day breakdown if needed.
 */
export interface MonthlySalesReport {
  /** Echo of the request's `month` in `YYYY-MM` form. */
  readonly month: string;
  /** `COUNT(*)` of `Sale` rows in the window. */
  readonly salesCount: number;
  /** `SUM(Sale.grandTotal)` as a decimal string. */
  readonly totalRevenue: string;
  /** `SUM(Sale.taxTotal)` as a decimal string. */
  readonly totalTax: string;
  /** `SUM(Sale.discount)` as a decimal string. */
  readonly totalDiscount: string;
}

// ---------------------------------------------------------------------------
// Low-stock summary (Req 9.3, 3.6)
// ---------------------------------------------------------------------------

/**
 * One row of the low-stock report. The full set is every product whose
 * current `Inventory.onHand <= Product.reorderLevel`. Mirrors the
 * projection used by the persistent `<LowStockBanner>` click-through
 * surface (design.md > "POS UI") so the renderer can drive both the
 * banner and the report from a single DTO shape.
 */
export interface LowStockRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly onHand: number;
  readonly reorderLevel: number;
}

// ---------------------------------------------------------------------------
// Top-selling (Req 9.4)
// ---------------------------------------------------------------------------

/**
 * One row of the top-selling report — a product ordered by total units
 * sold within the requested `[dateFrom, dateTo]` window (inclusive on
 * both ends). `unitsSold` is the sum of `SaleItem.quantity`;
 * `revenue` is the sum of `SaleItem.lineTotal` (pre-discount,
 * pre-tax) so it represents gross product revenue, not net sale
 * revenue.
 */
export interface TopSellingRow {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly unitsSold: number;
  /** Sum of `SaleItem.lineTotal` for this product, decimal-as-string. */
  readonly revenue: string;
}

// ---------------------------------------------------------------------------
// Export request (Req 9.5)
// ---------------------------------------------------------------------------

/**
 * Output formats supported by `reports:export`. Renderers may request
 * either format individually or both at once — the combined handler
 * drives a single shared cursor pump and feeds both encoders from
 * the same row buffer (Phase 10 task 10.7), so doubling the formats
 * does not double the memory footprint (Property 17).
 */
export type ReportExportFormat = 'csv' | 'pdf';

/**
 * Optional renderer-supplied destination paths. When omitted (or any
 * field omitted) the main process opens `dialog.showSaveDialog` for
 * the missing format(s); the user gesture is required by Electron's
 * file dialog API regardless. Tests bypass the dialog by passing
 * paths directly.
 */
export interface ReportExportPaths {
  readonly csv?: string;
  readonly pdf?: string;
}

/**
 * Request payload for `reports:export`. The `reportId` chooses which
 * report to render; `filter` and `sort` are forwarded into the
 * underlying cursor-paginated SELECT (design.md > "Streaming exports").
 *
 * `format` accepts a single format ('csv' | 'pdf') or both as an
 * array. When both are requested, the handler drives the underlying
 * SELECT exactly once and pipes each batch into both encoders so the
 * row buffer is shared and disposed per batch (task 10.7).
 *
 * `paths` lets the renderer (or tests) pre-pick destinations; the
 * handler opens a save dialog for any format whose path is missing.
 *
 * Phase 10 task 10.5 / 10.6 / 10.7 implement the export pipeline; the
 * type lives here so the handler skeleton can be wired alongside the
 * read-side report channels without a circular contract import.
 */
export interface ReportExportRequest {
  readonly reportId: 'dailySales' | 'monthlySales' | 'lowStock' | 'topSelling';
  readonly format: ReportExportFormat | readonly ReportExportFormat[];
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly sort?: { readonly key: string; readonly dir: 'asc' | 'desc' };
  readonly paths?: ReportExportPaths;
}

/**
 * Response payload for `reports:export`. Always carries `rowCount`;
 * the exact path fields depend on which formats were requested:
 *
 *   - Single format: `{ path, rowCount }` — `path` is the absolute
 *     output filename of the requested encoder.
 *   - Both formats: `{ csvPath, pdfPath, rowCount }`.
 *
 * Resolved only after every encoder's `finish` event fires.
 */
export interface ReportExportResponse {
  readonly rowCount: number;
  readonly path?: string;
  readonly csvPath?: string;
  readonly pdfPath?: string;
}
