// src/main/ipc/handlers/pos.ts
//
// IPC handlers for the POS channel group (Phase 7, tasks 7.2 + 7.4).
//
// Wires the `pos:scan` and `pos:finalize` channels into the router
// (`registerHandler`) on import via the exported
// `registerPosHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this after `registerPurchasesHandlers()`
// and before `bindIpcHandlers(ipcMain)` so the router is fully
// populated before Electron exposes the IPC surface to renderers.
//
// Channels:
//
//   - `pos:scan`     Allowed for both Admin and Cashier per the
//                    static RBAC matrix (`src/main/permission/matrix.ts`)
//                    — both roles drive the POS lookup. The handler
//                    forwards the request to `POSService.scan(req.barcode)`
//                    which performs a single `findUnique` against the
//                    `Product.barcode` unique index and returns the
//                    matching `ProductDTO | null` (Req 4.1, 12.1).
//                    No DB writes happen on this path.
//
//   - `pos:finalize` Allowed for both Admin and Cashier per the
//                    static RBAC matrix — both roles operate the POS
//                    surface (Req 4.x, 8.3). Forwards to
//                    `POSService.finalizeSale(req, ctx)` which opens
//                    its own `$transaction` to write the sale +
//                    items + payments + ledger movements + journal
//                    entry atomically. The acting `userId` is read
//                    off `ctx.session` and passed through so the
//                    sale's `cashierId`, each ledger movement's
//                    `userId`, and the journal payload all attribute
//                    the sale correctly.
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 11.1,
//            12.1, 12.2.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { POSService } from '@main/services/pos.service.js';
import { Err } from '@shared/result.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `pos:scan` handler. Allowed for Admin and Cashier roles by the
 * static matrix because both roles operate the POS surface (Req 4.1,
 * 8.3). The handler is a thin pass-through to the service: the
 * service owns input validation (empty / whitespace barcode →
 * `Err('VALIDATION', { field: 'barcode' })`) and the no-match path
 * (`Ok(null)` rather than an error envelope, per design.md "return
 * ProductDTO | null").
 *
 * The auth middleware still rejects unauthenticated calls because
 * the channel inherits the default `requiresAuth: true` — the POS
 * surface is only reachable after login.
 */
const scanHandler: HandlerFn<'pos:scan'> = async (req) => {
  return POSService.scan(req.barcode);
};

/**
 * `pos:finalize` handler. Allowed for Admin and Cashier roles by the
 * static matrix — both roles operate the POS surface (Req 4.x,
 * 8.3). The acting `userId` is read off `ctx.session` and passed
 * through to the service so the sale's `cashierId`, each ledger
 * movement's `userId`, and the journal payload all attribute the
 * sale correctly.
 *
 * The session is guaranteed to be present here because this channel
 * uses the default `requiresAuth: true`; the router returns
 * `Err('UNAUTHENTICATED')` before this handler runs if no session
 * is bound. Defence-in-depth: if a future change drops the
 * `requiresAuth` default, surface `INTERNAL` rather than writing the
 * sale row with an empty `cashierId` (mirrors the pattern in
 * `purchase:create`).
 */
const finalizeHandler: HandlerFn<'pos:finalize'> = async (req, ctx) => {
  if (ctx.session === undefined) {
    return Err('INTERNAL', { reason: 'missing_session' });
  }
  return POSService.finalizeSale(req, { userId: ctx.session.userId });
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every POS-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerPosHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware
  // enforces that only authenticated sessions reach these handlers.
  // Per the matrix both `pos:scan` and `pos:finalize` are
  // ALL_ROLES; both Admin and Cashier calls reach the service.
  registerHandler('pos:scan', {}, scanHandler);
  registerHandler('pos:finalize', {}, finalizeHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/pos.test.ts` so the handler functions
// can be exercised directly without driving the full router.
// Production code should always go through `registerPosHandlers`.
export const __testables = Object.freeze({
  scanHandler,
  finalizeHandler,
});
