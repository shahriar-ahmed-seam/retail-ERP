// src/main/ipc/handlers/inventory.ts
//
// IPC handlers for the inventory channel group (Phase 5, tasks 5.2 + 5.3
// + 5.5.1).
//
// Wires `inventory:adjust`, `inventory:lowStockCount`,
// `inventory_movements:list`, and `inventory_movements:count` into the
// router (`registerHandler`) on import via the exported
// `registerInventoryHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this after `registerProductsHandlers()`
// and before `bindIpcHandlers(ipcMain)` so the router is fully
// populated before Electron exposes the IPC surface to renderers.
//
// Channels:
//
//   - `inventory:adjust` (Admin only — Req 3.5, 8.2: cashiers cannot
//                         change stock levels manually)
//       Forwards directly to `InventoryService.adjust(input, ctx)`.
//       The service:
//         - validates the request shape (productId / non-zero
//           integer delta / bounded reason),
//         - opens a `$transaction` and writes
//           `Inventory` (cache update), `InventoryMovement` (ledger
//           row), `AuditLog` (`stock.adjust`), and `JournalEntry`
//           (`opType: 'adjustment'`) atomically,
//         - maps `OutOfStockError` to `Err('OUT_OF_STOCK', { productId })`
//           and Prisma's P2025 (unknown product) to
//           `Err('FK_VIOLATION', { reason: 'not_found' })`.
//       RBAC denial for the Cashier role is handled by the router
//       middleware against the static matrix
//       (`src/main/permission/matrix.ts`); this handler does not
//       re-check.
//
//   - `inventory:lowStockCount` (Admin + Cashier — Req 3.6)
//       Forwards directly to `InventoryService.lowStockCount()`.
//       Drives the persistent `<LowStockBanner>` component which
//       renders on every screen for both roles when count > 0
//       (design.md > "POS UI"). Read-only; no audit decorator
//       attached because banner reads run on a heartbeat and would
//       overwhelm the audit log without adding signal.
//
//   - `inventory_movements:list` (Admin only — Req 3.1, 8.2: the
//                         full movement ledger is an audit/admin
//                         tool; cashiers use the POS history view
//                         scoped to their own sales instead)
//       Forwards to `InventoryService.listMovements(req)`. The
//       service handles cursor decoding, page-size clamping, filter
//       compilation (`productId`, `movementType`, `dateFrom`,
//       `dateTo`), and projection of joined `Product.name` +
//       `User.username` onto each row's DTO.
//
//   - `inventory_movements:count` (Admin only)
//       Companion total-count for the same filter shape used by
//       `inventory_movements:list`. Forwards to
//       `InventoryService.countMovements(req)`.
//
// The companion `reports:lowStock` channel — same backing query as
// `lowStockCount`, but returning the full `LowStockRow[]` projection
// for the banner click-through and the daily summary export — lives
// in `reports.ts` (task 5.3). Phase 10 extends that module with the
// daily/monthly/topSelling reports.
//
// Validates: Requirements 3.1, 3.5, 3.6, 8.2, 8.4, 13.3, 16.1, 16.2,
//            16.3, 16.4.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { InventoryService } from '@main/services/inventory.service.js';
import { Err } from '@shared/result.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `inventory:adjust` handler. Admin-only by RBAC (the matrix in
 * `src/main/permission/matrix.ts` enforces this; cashiers see
 * `Err('FORBIDDEN')` from the router). The acting `userId` is read
 * off `ctx.session` and passed through to the service so the
 * `audit_logs` and `journal_entries` rows attribute the adjustment
 * correctly.
 *
 * The session is guaranteed to be present here because this channel
 * uses the default `requiresAuth: true`; the router returns
 * `Err('UNAUTHENTICATED')` before this handler runs if no session
 * is bound. Defence-in-depth: if a future change drops the
 * `requiresAuth` default, surface `INTERNAL` rather than writing the
 * audit row with an empty userId.
 */
const adjustHandler: HandlerFn<'inventory:adjust'> = async (req, ctx) => {
  if (ctx.session === undefined) {
    return Err('INTERNAL', { reason: 'missing_session' });
  }
  return InventoryService.adjust(req, { userId: ctx.session.userId });
};

/**
 * `inventory:lowStockCount` handler. Allowed for Admin and Cashier
 * roles by the matrix because the persistent `<LowStockBanner>` is
 * visible on every screen for both roles (Req 3.6, design.md > "POS
 * UI"). The handler is a thin pass-through to the service; no `ctx`
 * fields are read because the count is global (no row-level scoping
 * by acting user). The auth middleware still rejects unauthenticated
 * calls because the channel inherits the default `requiresAuth: true`
 * — anonymous renderers should never see business state.
 */
const lowStockCountHandler: HandlerFn<'inventory:lowStockCount'> = async () => {
  return InventoryService.lowStockCount();
};

/**
 * `inventory_movements:list` handler. Admin-only by RBAC; the matrix
 * forbids the Cashier role from reading the full movement ledger so
 * sensitive data like price-impacting adjustments is not exposed to
 * the POS surface (Req 8.2). Filter, sort, cursor, and page-size
 * normalization live in `InventoryService.listMovements`; the
 * handler is a thin adapter that preserves the `ListRequest` shape
 * verbatim.
 */
const movementsListHandler: HandlerFn<'inventory_movements:list'> = async (req) => {
  return InventoryService.listMovements(req);
};

/**
 * `inventory_movements:count` handler. Admin-only companion to
 * `inventory_movements:list`. Forwards the `{ filter?, search? }`
 * envelope unchanged — the service ignores `search` today (the
 * channel contract has no search filter on the list either) but
 * keeping the wire shape consistent across every count channel lets
 * the renderer's pagination hook treat them uniformly.
 */
const movementsCountHandler: HandlerFn<'inventory_movements:count'> = async (req) => {
  return InventoryService.countMovements(req);
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every inventory-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerInventoryHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware
  // enforces that only authenticated sessions reach this handler.
  // Per the matrix, `inventory:adjust` is ADMIN_ONLY; cashier
  // calls return `Err('FORBIDDEN')` and write an `rbac.deny` audit
  // row before the handler is invoked (Req 8.4).
  registerHandler('inventory:adjust', {}, adjustHandler);

  // `inventory:lowStockCount` is ALL_ROLES per the matrix — the
  // persistent banner needs the count regardless of which role is
  // signed in. Defaults to `requiresAuth: true`; the renderer's
  // banner component never polls before login.
  registerHandler('inventory:lowStockCount', {}, lowStockCountHandler);

  // `inventory_movements:list` and `inventory_movements:count` are
  // ADMIN_ONLY per the matrix. The router emits an `rbac.deny` audit
  // row for Cashier attempts before this handler runs (Req 8.4).
  registerHandler('inventory_movements:list', {}, movementsListHandler);
  registerHandler('inventory_movements:count', {}, movementsCountHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/inventory.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerInventoryHandlers`.
export const __testables = Object.freeze({
  adjustHandler,
  lowStockCountHandler,
  movementsListHandler,
  movementsCountHandler,
});
