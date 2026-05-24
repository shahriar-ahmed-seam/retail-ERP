// src/main/ipc/handlers/customers.ts
//
// IPC handlers for the customers channel group (Phase 9, task 9.1).
//
// Wires four channels into the router (`registerHandler`) on import
// via the exported `registerCustomersHandlers()` function. The
// bootstrap in `src/main/index.ts` calls this alongside the other
// `register*Handlers()` entries so the router is fully populated
// before Electron exposes the IPC surface to renderers.
//
// Channels (all Admin + Cashier per the static RBAC matrix —
// `src/main/permission/matrix.ts`. Cashiers attach customers to
// sales (Req 7.2) and look up prior purchases (Req 7.3); the matrix
// authorizes the channel and the service lets every authenticated
// session drive it):
//
//   - `customers:list`    Forwards directly to `CustomerService.list(req)`.
//                         The service owns cursor decoding, page-size
//                         clamping, search compilation, and DTO mapping.
//
//   - `customers:count`   Forwards to `CustomerService.count(req)`.
//                         Companion total-count for the same filter +
//                         search shape used by the list channel.
//
//   - `customers:upsert`  Forwards to `CustomerService.upsert(req)`.
//                         Allowed for both roles because the POS UI
//                         creates walk-in customer records mid-checkout
//                         (Req 7.2).
//
//   - `customers:detail`  Forwards to `CustomerService.detail(req)`.
//                         Returns the customer record plus a paginated
//                         page of its sale history (cursor on
//                         `(createdAt DESC, id)`).
//
// Validates: Requirements 7.1, 7.2, 7.3, 8.4, 16.1, 16.2, 16.3.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { CustomerService } from '@main/services/customer.service.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** `customers:list` handler. Thin adapter around `CustomerService.list`. */
const listHandler: HandlerFn<'customers:list'> = async (req) => {
  return CustomerService.list(req);
};

/**
 * `customers:count` handler. Companion total-count for the same
 * filter + search shape used by `customers:list`. The wire request
 * shape (`{ filter?, search? }`) is preserved verbatim — the service
 * does not need cursor or page size for a count.
 */
const countHandler: HandlerFn<'customers:count'> = async (req) => {
  return CustomerService.count(req);
};

/**
 * `customers:upsert` handler. Allowed for both Admin and Cashier
 * roles: cashiers create walk-in customer records mid-checkout
 * (Req 7.2). The service does not receive a session ctx because
 * customer writes are not part of the audit-tracked surface — design
 * .md only requires audit rows for price changes, role changes,
 * stock adjustments, and RBAC denials.
 */
const upsertHandler: HandlerFn<'customers:upsert'> = async (req) => {
  return CustomerService.upsert(req);
};

/**
 * `customers:detail` handler. Returns the customer record plus a
 * page of its sale history (Req 7.3). The history sub-list is
 * paginated via the standard cursor envelope; the renderer drives
 * subsequent pages by re-calling this channel with the `nextCursor`
 * baked into the previous response's `history.nextCursor`.
 */
const detailHandler: HandlerFn<'customers:detail'> = async (req) => {
  return CustomerService.detail(req);
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every customers-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerCustomersHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware
  // enforces that only authenticated sessions reach these handlers.
  // Per the matrix all four channels are ALL_ROLES; there is no
  // RBAC denial path for customers under the current matrix.
  registerHandler('customers:list', {}, listHandler);
  registerHandler('customers:count', {}, countHandler);
  registerHandler('customers:upsert', {}, upsertHandler);
  registerHandler('customers:detail', {}, detailHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/customers.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerCustomersHandlers`.
export const __testables = Object.freeze({
  listHandler,
  countHandler,
  upsertHandler,
  detailHandler,
});
