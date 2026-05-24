// src/main/ipc/handlers/products.ts
//
// IPC handlers for the products channel group (Phase 4, task 4.2).
//
// Wires three channels into the router (`registerHandler`) on import via
// the exported `registerProductsHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this after `registerCategoriesHandlers()` and
// before `bindIpcHandlers(ipcMain)` so the router is fully populated
// before Electron exposes the IPC surface to renderers.
//
// Channels:
//
//   - `products:list`   (Admin + Cashier per the static RBAC matrix —
//                        cashiers need read access to look up items at
//                        the POS, Req 2.x / 8.3)
//       Forwards directly to `ProductService.list(req)`. The service
//       owns cursor decoding, page-size clamping, and search/filter
//       compilation.
//
//   - `products:count`  (Admin + Cashier)
//       Companion total-count for the list channel's filter + search
//       shape. Forwards to `ProductService.count(req)`.
//
//   - `products:upsert` (Admin only — Req 2.4, 8.3, 13.1: only Admin
//                        edits pricing / SKU / barcode)
//       Forwards to `ProductService.upsert(input, ctx)`. RBAC denial
//       for the Cashier role is handled by the router middleware
//       against the static matrix; this handler does not re-check.
//       The acting `userId` is read off `ctx.session` (always defined
//       on this channel — `requiresAuth` is the default `true`) and
//       passed through so the price-audit task (4.3) can attribute
//       the change correctly without changing the service signature.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.5, 7 (read-only access).

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { ProductService } from '@main/services/product.service.js';
import { Err } from '@shared/result.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `products:list` handler. Thin adapter around `ProductService.list`.
 * Filter, search, sort, cursor, and page size are validated /
 * normalized in the service.
 */
const listHandler: HandlerFn<'products:list'> = async (req) => {
  return ProductService.list(req);
};

/**
 * `products:count` handler. Companion total-count for the same filter
 * + search shape used by `products:list`. The wire request shape
 * (`{ filter?, search? }`) is preserved verbatim — the service does
 * not need cursor or page size for a count.
 */
const countHandler: HandlerFn<'products:count'> = async (req) => {
  return ProductService.count(req);
};

/**
 * `products:upsert` handler. Admin-only by RBAC (the matrix in
 * `src/main/permission/matrix.ts` enforces this; cashiers see
 * `Err('FORBIDDEN')` from the router). The acting `userId` is read
 * off `ctx.session` and passed through to the service so a future
 * price-change audit (task 4.3) can attribute the change correctly.
 *
 * The session is guaranteed to be present here because this channel
 * uses the default `requiresAuth: true`; the router returns
 * `Err('UNAUTHENTICATED')` before this handler runs if no session is
 * bound. Defence-in-depth: if a future change drops the `requiresAuth`
 * default we still surface `INTERNAL` instead of writing the audit
 * row with an empty userId.
 */
const upsertHandler: HandlerFn<'products:upsert'> = async (req, ctx) => {
  if (ctx.session === undefined) {
    return Err('INTERNAL', { reason: 'missing_session' });
  }
  return ProductService.upsert(req, { userId: ctx.session.userId });
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every products-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this twice
 * (e.g. under HMR or in tests) is safe.
 */
export function registerProductsHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware enforces
  // that only authenticated sessions reach these handlers. Per the
  // matrix:
  //   - `products:list` and `products:count` allow Admin + Cashier
  //   - `products:upsert` allows Admin only
  registerHandler('products:list', {}, listHandler);
  registerHandler('products:count', {}, countHandler);
  registerHandler('products:upsert', {}, upsertHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/products.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerProductsHandlers`.
export const __testables = Object.freeze({
  listHandler,
  countHandler,
  upsertHandler,
});
