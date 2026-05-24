// src/main/ipc/handlers/purchases.ts
//
// IPC handlers for the purchases channel group (Phase 6, task 6.2).
//
// Wires three channels into the router (`registerHandler`) on import
// via the exported `registerPurchasesHandlers()` function. The
// bootstrap in `src/main/index.ts` calls this after
// `registerSuppliersHandlers()` and before `bindIpcHandlers(ipcMain)`
// so the router is fully populated before Electron exposes the IPC
// surface to renderers.
//
// Channels (all Admin-only per the static RBAC matrix —
// `src/main/permission/matrix.ts`; purchases are an Admin workflow
// per Req 5.1 + 8.2):
//
//   - `purchase:create`  Forwards to `PurchaseService.create(req, ctx)`.
//                        The service opens its own `$transaction` to
//                        write the header + items + ledger movements +
//                        journal entry atomically. The acting `userId`
//                        is read off `ctx.session` and passed through
//                        so the journal payload + each ledger
//                        movement attribute the purchase correctly.
//
//   - `purchases:list`   Forwards directly to `PurchaseService.list(req)`.
//                        The service owns cursor decoding, page-size
//                        clamping, filter compilation (`supplierId`,
//                        `dateFrom`, `dateTo`), and projection of
//                        joined `Supplier.name` + `_count.items` onto
//                        each row's DTO.
//
//   - `purchases:count`  Forwards to `PurchaseService.count(req)`.
//                        Companion total-count for the same filter
//                        shape used by the list channel.
//
// RBAC denial for the Cashier role is handled by the router
// middleware against the static matrix; this handler does not
// re-check.
//
// Validates: Requirements 5.1, 5.5, 8.2, 8.4, 11.2, 16.1, 16.2, 16.3.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { PurchaseService } from '@main/services/purchase.service.js';
import { Err } from '@shared/result.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `purchase:create` handler. Admin-only by RBAC (the matrix in
 * `src/main/permission/matrix.ts` enforces this; cashiers see
 * `Err('FORBIDDEN')` from the router and an `rbac.deny` audit row is
 * written before this handler runs, Req 8.4). The acting `userId` is
 * read off `ctx.session` and passed through to the service so the
 * journal payload + each ledger movement attribute the purchase
 * correctly.
 *
 * The session is guaranteed to be present here because this channel
 * uses the default `requiresAuth: true`; the router returns
 * `Err('UNAUTHENTICATED')` before this handler runs if no session is
 * bound. Defence-in-depth: if a future change drops the
 * `requiresAuth` default, surface `INTERNAL` rather than writing the
 * journal row with an empty userId.
 */
const createHandler: HandlerFn<'purchase:create'> = async (req, ctx) => {
  if (ctx.session === undefined) {
    return Err('INTERNAL', { reason: 'missing_session' });
  }
  return PurchaseService.create(req, { userId: ctx.session.userId });
};

/** `purchases:list` handler. Thin adapter around `PurchaseService.list`. */
const listHandler: HandlerFn<'purchases:list'> = async (req) => {
  return PurchaseService.list(req);
};

/**
 * `purchases:count` handler. Companion total-count for the same
 * filter shape used by `purchases:list`. The wire request shape
 * (`{ filter?, search? }`) is preserved verbatim — the service does
 * not need cursor or page size for a count.
 */
const countHandler: HandlerFn<'purchases:count'> = async (req) => {
  return PurchaseService.count(req);
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every purchases-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerPurchasesHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware
  // enforces that only authenticated sessions reach these handlers.
  // Per the matrix all three channels are ADMIN_ONLY; cashier calls
  // return `Err('FORBIDDEN')` and write an `rbac.deny` audit row
  // before the handler runs (Req 8.4).
  registerHandler('purchase:create', {}, createHandler);
  registerHandler('purchases:list', {}, listHandler);
  registerHandler('purchases:count', {}, countHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/purchases.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerPurchasesHandlers`.
export const __testables = Object.freeze({
  createHandler,
  listHandler,
  countHandler,
});
