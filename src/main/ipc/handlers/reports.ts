// src/main/ipc/handlers/reports.ts
//
// IPC handlers for the reports channel group (Phase 5, task 5.3
// scaffold; Phase 10 fills in the rest).
//
// Wires `reports:lowStock` into the router on import via the
// exported `registerReportsHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this alongside the other handler-group
// registrations so the router is fully populated before
// `bindIpcHandlers(ipcMain)` exposes the IPC surface to renderers.
//
// Channels:
//
//   - `reports:lowStock` (Admin + Cashier — Req 3.6, 9.3)
//       Forwards directly to `InventoryService.lowStockList()`.
//       Returns the full `LowStockRow[]` projection (productId, sku,
//       name, onHand, reorderLevel) sorted most-urgent first
//       (highest reorderLevel, then lowest onHand, then name).
//       Drives:
//         - the renderer's `<LowStockBanner>` click-through, which
//           opens the low-stock report page,
//         - the daily summary export's "low-stock" section
//           (Phase 10).
//       The channel is read-only and has no parameters; the matrix
//       (`src/main/permission/matrix.ts`) grants both Admin and
//       Cashier access because the banner the channel backs is
//       visible on every screen for both roles.
//
// Phase 10 will extend this module with `reports:dailySales`,
// `reports:monthlySales`, `reports:topSelling`, and `reports:export`.
// Splitting the reports handlers into their own module now —
// rather than parking `reports:lowStock` inside `inventory.ts` —
// keeps the per-module surface small and matches the convention
// established by `auth.ts` / `categories.ts` / `products.ts` /
// `inventory.ts`.
//
// Validates: Requirements 3.6, 9.3, 8.4.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { InventoryService } from '@main/services/inventory.service.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `reports:lowStock` handler. Allowed for Admin and Cashier per the
 * matrix because the banner the channel backs is visible on every
 * screen for both roles (Req 3.6, 9.3). Thin pass-through to the
 * service: no per-call validation is needed because the request
 * shape is `void`. Read-only; no audit decorator attached because
 * banner expansions and report previews would generate audit-row
 * volume out of proportion to their signal value — the audit log
 * focuses on state-changing actions (price changes, stock
 * adjustments, RBAC denials) per design.md > "Audit log".
 */
const lowStockReportHandler: HandlerFn<'reports:lowStock'> = async () => {
  return InventoryService.lowStockList();
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
  // Default `requiresAuth: true` — the auth middleware rejects
  // anonymous renderers; the RBAC matrix grants both Admin and
  // Cashier so neither role sees a `FORBIDDEN` envelope.
  registerHandler('reports:lowStock', {}, lowStockReportHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/reports.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerReportsHandlers`.
export const __testables = Object.freeze({
  lowStockReportHandler,
});
