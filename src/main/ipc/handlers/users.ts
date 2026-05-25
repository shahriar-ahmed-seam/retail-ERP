// src/main/ipc/handlers/users.ts
//
// IPC handlers for the users channel group (Phase 12, task 12.2).
//
// Wires `users:assignRole` into the router (`registerHandler`) on
// import via the exported `registerUsersHandlers()` function. The
// bootstrap in `src/main/index.ts` calls this alongside the other
// `register*Handlers()` entries so the router is fully populated
// before Electron exposes the IPC surface to renderers.
//
// Channels:
//
//   - `users:assignRole` (Admin only — Req 8.5, 8.2)
//       Forwards to `AuthService.assignRole(input, ctx)`. The service
//       opens a single `$transaction` that:
//         (a) reads the target user with their current role,
//         (b) reads the new role,
//         (c) updates `User.roleId`,
//         (d) writes an `audit_logs` row of type `role.change`
//             carrying `{ roleId, roleName }` snapshots for both
//             `previous` and `next`,
//         (e) writes a `journal_entries` row of opType `role.change`
//             carrying the target user, both role snapshots, the
//             acting user, and an ISO timestamp.
//       Service maps:
//         - missing user / role → `Err('FK_VIOLATION', { reason:
//           'not_found', field })`,
//         - non-`Admin | Cashier` role name → `Err('DB_INTEGRITY')`,
//         - empty / invalid input → `Err('VALIDATION', { field })`,
//         - no-op assignment (current role == new role) →
//           `Ok(currentUserDTO)` without writing audit / journal rows.
//
// RBAC denial for the Cashier role is handled by the router
// middleware against the static matrix
// (`src/main/permission/matrix.ts`); this handler does not
// re-check. The middleware emits an `audit_logs` row of type
// `rbac.deny` for cashier attempts before this handler runs (Req 8.4).
//
// Note: `users:list` and `users:upsert` are declared in the IPC
// contract but are not wired here yet — the dedicated user
// management UI (out of scope for task 12.2) lands in a later
// phase. The static RBAC matrix lists both as Admin-only so
// adding handlers later does not require a matrix change.
//
// Validates: Requirements 8.5, 13.2, 8.4.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { AuthService } from '@main/services/auth.service.js';
import { Err } from '@shared/result.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `users:assignRole` handler. Admin-only by RBAC; the matrix
 * forbids the Cashier role (Req 8.2). The acting `userId` is read
 * off `ctx.session` and passed through to the service so the
 * `audit_logs` and `journal_entries` rows attribute the role change
 * correctly (Req 8.5, 13.2).
 *
 * The session is guaranteed to be present here because this channel
 * uses the default `requiresAuth: true`; the router returns
 * `Err('UNAUTHENTICATED')` before this handler runs if no session
 * is bound. Defence-in-depth: surface `INTERNAL` rather than
 * writing the audit / journal rows with an empty `userId` if a
 * future change drops the `requiresAuth` default.
 */
const assignRoleHandler: HandlerFn<'users:assignRole'> = async (req, ctx) => {
  if (ctx.session === undefined) {
    return Err('INTERNAL', { reason: 'missing_session' });
  }
  return AuthService.assignRole(req, { userId: ctx.session.userId });
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every users-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerUsersHandlers(): void {
  // Default `requiresAuth: true` — the auth + RBAC middleware
  // enforces that only authenticated Admin sessions reach this
  // handler. The audit row for the role change itself is written
  // INSIDE the service's `$transaction` (atomic with the user
  // update + journal entry), not via the router's declarative
  // audit decorator — a no-op assignment must NOT produce an
  // audit row, which the declarative path cannot express.
  registerHandler('users:assignRole', {}, assignRoleHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/users.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerUsersHandlers`.
export const __testables = Object.freeze({
  assignRoleHandler,
});
