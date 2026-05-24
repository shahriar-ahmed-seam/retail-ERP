// src/main/ipc/handlers/suppliers.ts
//
// IPC handlers for the suppliers channel group (Phase 6, task 6.1).
//
// Wires four channels into the router (`registerHandler`) on import
// via the exported `registerSuppliersHandlers()` function. The
// bootstrap in `src/main/index.ts` calls this after
// `registerInventoryHandlers()` and before `bindIpcHandlers(ipcMain)`
// so the router is fully populated before Electron exposes the IPC
// surface to renderers.
//
// Channels (all Admin-only per the static RBAC matrix —
// `src/main/permission/matrix.ts`; supplier directory is purchasing-
// side only, Req 6.x / 8.2):
//
//   - `suppliers:list`   Forwards directly to `SupplierService.list(req)`.
//                        The service owns cursor decoding, page-size
//                        clamping, search compilation, and DTO mapping.
//
//   - `suppliers:count`  Forwards to `SupplierService.count(req)`.
//                        Companion total-count for the same filter +
//                        search shape used by the list channel.
//
//   - `suppliers:upsert` Forwards to `SupplierService.upsert(req)`.
//                        RBAC denial for the Cashier role is handled
//                        by the router middleware against the static
//                        matrix; this handler does not re-check.
//
//   - `suppliers:detail` Forwards to `SupplierService.detail(req)`.
//                        Returns the supplier record plus a paginated
//                        page of its purchase history (cursor on
//                        `(createdAt DESC, id)`).
//
// Validates: Requirements 6.1, 6.2, 6.3, 8.2, 8.4, 16.1, 16.2, 16.3.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { SupplierService } from '@main/services/supplier.service.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** `suppliers:list` handler. Thin adapter around `SupplierService.list`. */
const listHandler: HandlerFn<'suppliers:list'> = async (req) => {
  return SupplierService.list(req);
};

/**
 * `suppliers:count` handler. Companion total-count for the same
 * filter + search shape used by `suppliers:list`. The wire request
 * shape (`{ filter?, search? }`) is preserved verbatim — the service
 * does not need cursor or page size for a count.
 */
const countHandler: HandlerFn<'suppliers:count'> = async (req) => {
  return SupplierService.count(req);
};

/**
 * `suppliers:upsert` handler. Admin-only by RBAC (cashiers see
 * `Err('FORBIDDEN')` from the router and an `rbac.deny` audit row is
 * written before this handler runs, Req 8.4). The service does not
 * receive a session ctx because supplier writes are not part of the
 * audit-tracked surface — design.md only requires audit rows for
 * price changes, role changes, stock adjustments, and RBAC denials.
 */
const upsertHandler: HandlerFn<'suppliers:upsert'> = async (req) => {
  return SupplierService.upsert(req);
};

/**
 * `suppliers:detail` handler. Returns the supplier record plus a
 * page of its purchase history (Req 6.3). The history sub-list is
 * paginated via the standard cursor envelope; the renderer drives
 * subsequent pages by re-calling this channel with the `nextCursor`
 * baked into the previous response's `history.nextCursor`.
 */
const detailHandler: HandlerFn<'suppliers:detail'> = async (req) => {
  return SupplierService.detail(req);
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every suppliers-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerSuppliersHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware
  // enforces that only authenticated sessions reach these handlers.
  // Per the matrix all four channels are ADMIN_ONLY; cashier calls
  // return `Err('FORBIDDEN')` and write an `rbac.deny` audit row
  // before the handler runs (Req 8.4).
  registerHandler('suppliers:list', {}, listHandler);
  registerHandler('suppliers:count', {}, countHandler);
  registerHandler('suppliers:upsert', {}, upsertHandler);
  registerHandler('suppliers:detail', {}, detailHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/suppliers.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerSuppliersHandlers`.
export const __testables = Object.freeze({
  listHandler,
  countHandler,
  upsertHandler,
  detailHandler,
});
