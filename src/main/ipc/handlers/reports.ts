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
//   - `reports:export`       (Admin only — Req 9.5, 16.6)
//       Drives the streaming export pipeline (Phase 10 tasks 10.5–10.7).
//       Accepts a single format ('csv' | 'pdf') or both at once and
//       returns the path(s) of the resulting file(s) plus the row
//       count. Renderer-supplied destination paths bypass
//       `dialog.showSaveDialog`; otherwise the handler opens one
//       dialog per missing format and surfaces user cancellation as
//       `Err('USER_CANCELED')`.
//
// All four read-side channels are read-only; no audit decorator is
// attached. The export handler also skips the audit decorator —
// audit-row volume from per-export writes would be out of proportion
// to their signal value, and the underlying SELECT is a read-only
// aggregation.
//
// Validates: Requirements 3.6, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 16.3,
//            16.6.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { exportReport } from '@main/services/report/index.js';
import { ReportService } from '@main/services/report.service.js';
import { Err } from '@shared/result.js';

import type {
  ReportExportFormat,
  ReportExportPaths,
  ReportExportRequest,
} from '@shared/dto/index.js';
import type { Result } from '@shared/result.js';

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
// reports:export handler (Phase 10, task 10.7)
// ---------------------------------------------------------------------------

/**
 * Adapter for `dialog.showSaveDialog`. Returns the user-chosen path,
 * or `null` if the user canceled. Pluggable so unit tests can drive
 * the handler without spinning up Electron's full dialog surface;
 * production wires the lazy electron-aware loader below.
 */
export type SaveDialogOpener = (options: {
  readonly title: string;
  readonly defaultPath: string;
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}) => Promise<string | null>;

/**
 * Default save-dialog opener. Lazily requires `electron` so unit
 * tests do not need a real Electron host. When the module is
 * unavailable (test runner with no `electron` binding), falls back
 * to throwing — the handler converts that into an `Err('INTERNAL')`.
 *
 * Production behavior: opens `dialog.showSaveDialog`, returns the
 * chosen `filePath`, or `null` when the user dismissed the dialog.
 */
async function defaultShowSaveDialog(
  options: {
    readonly title: string;
    readonly defaultPath: string;
    readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
  },
): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as {
    dialog?: {
      showSaveDialog: (
        opts: { title: string; defaultPath: string; filters: readonly { name: string; extensions: readonly string[] }[] },
      ) => Promise<{ canceled: boolean; filePath?: string }>;
    };
  };
  if (electron.dialog === undefined) {
    throw new Error('electron.dialog is not available in this process');
  }
  const result = await electron.dialog.showSaveDialog({
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters.map((f) => ({
      name: f.name,
      extensions: [...f.extensions],
    })),
  });
  if (result.canceled || typeof result.filePath !== 'string' || result.filePath.length === 0) {
    return null;
  }
  return result.filePath;
}

let activeSaveDialogOpener: SaveDialogOpener = defaultShowSaveDialog;

/**
 * Replace the active save-dialog opener. Used by unit and integration
 * tests so a synthetic test-supplied path is returned without
 * spinning up the real Electron dialog.
 */
export function setSaveDialogOpener(opener: SaveDialogOpener): void {
  activeSaveDialogOpener = opener;
}

/**
 * Reset the save-dialog opener back to the production
 * Electron-backed implementation.
 */
export function resetSaveDialogOpener(): void {
  activeSaveDialogOpener = defaultShowSaveDialog;
}

/**
 * Resolve renderer-supplied paths into a fully-populated
 * `{ csv?, pdf? }` shape, opening one save dialog per format that
 * was requested but not pre-supplied. Returns `Err('USER_CANCELED')`
 * if the user dismissed any of the dialogs (the partial export is
 * abandoned — we do not run a CSV export when the PDF dialog was
 * canceled).
 */
async function resolvePaths(
  request: ReportExportRequest,
): Promise<Result<{ csv?: string; pdf?: string }>> {
  const formats = normalizeFormats(request.format);
  if (formats.length === 0) {
    return Err('VALIDATION', { field: 'format' });
  }
  const supplied: ReportExportPaths = request.paths ?? {};
  const resolved: { csv?: string; pdf?: string } = {};

  for (const format of formats) {
    const preset = format === 'csv' ? supplied.csv : supplied.pdf;
    if (typeof preset === 'string' && preset.length > 0) {
      resolved[format] = preset;
      continue;
    }
    const dialogResult = await activeSaveDialogOpener({
      title: format === 'csv' ? 'Save CSV Export' : 'Save PDF Export',
      defaultPath: `${request.reportId}.${format}`,
      filters: [
        format === 'csv'
          ? { name: 'CSV', extensions: ['csv'] }
          : { name: 'PDF', extensions: ['pdf'] },
      ],
    });
    if (dialogResult === null) {
      return Err('USER_CANCELED', { format });
    }
    resolved[format] = dialogResult;
  }
  return { ok: true, value: resolved };
}

/** Normalize the `format` field into a deduplicated array of formats. */
function normalizeFormats(
  format: ReportExportRequest['format'],
): ReportExportFormat[] {
  if (typeof format === 'string') return [format];
  if (Array.isArray(format)) {
    const seen = new Set<ReportExportFormat>();
    for (const f of format as readonly ReportExportFormat[]) {
      if (f === 'csv' || f === 'pdf') seen.add(f);
    }
    return [...seen];
  }
  return [];
}

const exportHandler: HandlerFn<'reports:export'> = async (req) => {
  const pathsResult = await resolvePaths(req);
  if (!pathsResult.ok) {
    return pathsResult;
  }
  return exportReport({ request: req, paths: pathsResult.value });
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
  registerHandler('reports:export', {}, exportHandler);
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
  exportHandler,
});
