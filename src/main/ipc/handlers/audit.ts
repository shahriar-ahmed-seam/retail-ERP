// src/main/ipc/handlers/audit.ts
//
// IPC handlers for the audit log read channels (Phase 12, task 12.1).
//
// Wires `audit:list` and `audit:count` into the router
// (`registerHandler`) on import via the exported
// `registerAuditHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this alongside the other
// `register*Handlers()` entries so the router is fully populated
// before Electron exposes the IPC surface to renderers.
//
// Channels:
//
//   - `audit:list` (Admin only — Req 13, 8.2)
//       Forwards directly to `AuditService.list(req)`. The service
//       owns cursor decoding, page-size clamping, filter compilation
//       (`actionType`, `userId`, `dateFrom`, `dateTo`), and the
//       per-page username lookup.
//
//   - `audit:count` (Admin only)
//       Companion total-count for the same filter shape used by
//       `audit:list`. Forwards to `AuditService.count(req)`.
//
// RBAC denial for the Cashier role is handled by the router
// middleware against the static matrix
// (`src/main/permission/matrix.ts`); this handler does not re-check.
// The middleware emits an `audit_logs` row of type `rbac.deny` for
// cashier attempts before this handler runs (Req 8.4) — in this
// case the audit log itself logs attempts to read the audit log,
// which is the intended behaviour.
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.4, 16.1, 16.2, 16.3,
//            16.5, 8.4.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { AuditService } from '@main/services/audit.service.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `audit:list` handler. Thin adapter around `AuditService.list`.
 * Admin-only by RBAC.
 */
const listHandler: HandlerFn<'audit:list'> = async (req) => {
  return AuditService.list(req);
};

/**
 * `audit:count` handler. Companion total-count for the same filter
 * shape used by `audit:list`. Wire request shape (`{ filter?,
 * search? }`) is preserved verbatim — `search` is currently unused
 * on this channel (the list does not accept a search term either)
 * but keeping the parameter in the signature lets a future
 * text-search filter slot in without changing the IPC contract.
 */
const countHandler: HandlerFn<'audit:count'> = async (req) => {
  return AuditService.count(req);
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every audit-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerAuditHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware
  // enforces that only authenticated Admin sessions reach these
  // handlers. The matrix denies the Cashier role and writes an
  // `rbac.deny` audit row before either handler runs (Req 8.4).
  registerHandler('audit:list', {}, listHandler);
  registerHandler('audit:count', {}, countHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/audit.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerAuditHandlers`.
export const __testables = Object.freeze({
  listHandler,
  countHandler,
});
