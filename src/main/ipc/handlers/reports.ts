// src/main/ipc/handlers/reports.ts
//
// IPC handlers for the reports channel group.
//
// Wires four read-side report channels through the router via the
// exported `registerReportsHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this alongside the other handler-group
// registrations so the router is fully populated before
// `bindIpcHandlers(ipcMain)` exposes the IPC surface to renderers.
//
// Channels:
//
//   - `reports:dailySales`   (Admin only — Req 9.1, 8.2)
//       Forwards to `ReportService.dailySales({ date })`.
//
//   - `reports:monthlySales` (Admin only — Req 9.2, 8.2)
//       Forwards to `ReportService.monthlySales({ month })`.
//
//   - `reports:lowStock`     (Admin + Cashier — Req 3.6, 9.3)
//       Forwards to `ReportService.lowStockSummary()` (which itself
//       delegates to `InventoryService.lowStockList()` so the banner
//       click-through and the report channel share one projection).
//       The matrix grants both roles because the persistent
//       `<LowStockBanner>` is visible on every screen for both Admin
//       and Cashier.
//
//   - `reports:topSelling`   (Admin only — Req 9.4, 8.2)
//       Forwards to `ReportService.topSelling({ dateFrom, dateTo, limit })`.
//
// The `reports:export` channel (Req 9.5) is intentionally NOT wired
// here yet — that's Phase 10 tasks 10.5/10.6/10.7. This module's sole
// job is the four read-side report channels.
//
// All four channels are read-only; no audit decorator is attached.
// Audit-row volume from per-report-view writes would be out of
// proportion to their signal value — the audit log focuses on
// state-changing actions (price changes, stock adjustments, RBAC
// denials) per design.md > "Audit log".
//
// Validates: Requirements 3.6, 8.4, 9.1, 9.2, 9.3, 9.4.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { ReportService } from '@main/services/report.service.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `reports:dailySales` handler. Admin-only per the matrix. Thin
 * pass-through to the service: validation of the `date` field
 * (`YYYY-MM-DD` shape, real calendar day) lives in the service so
 * malformed input surfaces as `Err('VALIDATION', { field: 'date' })`
 * before any DB query runs.
 */
const dailySalesHandler: HandlerFn<'reports:dailySales'> = async (req) => {
  return ReportService.dailySales(req);
};

/**
 * `reports:monthlySales` handler. Admin-only per the matrix. Same
 * thin-shell pattern as `dailySales`; the service validates the
 * `month` field (`YYYY-MM`) and surfaces a `VALIDATION` envelope on
 * malformed input.
 */
const monthlySalesHandler: HandlerFn<'reports:monthlySales'> = async (req) => {
  return ReportService.monthlySales(req);
};

/**
 * `reports:lowStock` handler. Allowed for Admin and Cashier per the
 * matrix because the banner the channel backs is visible on every
 * screen for both roles (Req 3.6, 9.3). Read-only — no audit
 * decorator attached.
 */
const lowStockReportHandler: HandlerFn<'reports:lowStock'> = async () => {
  return ReportService.lowStockSummary();
};

/**
 * `reports:topSelling` handler. Admin-only per the matrix. Forwards
 * the `{ dateFrom, dateTo, limit? }` request shape to the service,
 * which validates the date strings and clamps `limit` to the
 * service-level bound.
 */
const topSellingHandler: HandlerFn<'reports:topSelling'> = async (req) => {
  return ReportService.topSelling(req);
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every reports-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerReportsHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware
  // enforces that only authenticated sessions reach these handlers.
  // RBAC denial paths (Cashier hitting an Admin-only channel) write
  // an `rbac.deny` audit row before this code runs.
  registerHandler('reports:dailySales', {}, dailySalesHandler);
  registerHandler('reports:monthlySales', {}, monthlySalesHandler);
  registerHandler('reports:lowStock', {}, lowStockReportHandler);
  registerHandler('reports:topSelling', {}, topSellingHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/reports.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerReportsHandlers`.
export const __testables = Object.freeze({
  dailySalesHandler,
  monthlySalesHandler,
  lowStockReportHandler,
  topSellingHandler,
});
