// src/main/ipc/handlers/auth.ts
//
// IPC handlers for the auth + first-run-setup channel group (Phase 3, task 3.2).
//
// Wires three channels into the router (`registerHandler`) on import via the
// exported `registerAuthHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this function once before `bindIpcHandlers` so
// the router is fully populated before Electron's `ipcMain` is exposed to
// renderers.
//
// Channels:
//
//   - `auth:login` (public, requiresAuth: false)
//       Calls `AuthService.login(username, password)`. On `Ok`, binds the
//       returned `SessionDTO` to the renderer's `senderId` via
//       `sessionStore.bind` so subsequent channels pass the auth + RBAC
//       middleware in `router.ts`. Returns the same `SessionDTO` to the
//       renderer; on `Err` the envelope is forwarded verbatim and no
//       session is bound.
//
//   - `auth:logout` (public, requiresAuth: false)
//       Public so a renderer holding a stale binding (e.g. after a service
//       restart) can still tear it down. Calls `AuthService.logout(ctx.senderId)`
//       which clears the binding for this sender id; idempotent.
//
//   - `setup:createInitialAdmin` (public, requiresAuth: false)
//       Reachable only when `hasAnyAdmin()` is false. The gate lives inside
//       `AuthService.createInitialAdmin` (which returns
//       `Err('FORBIDDEN', { reason: 'admin_already_exists' })` once an admin
//       exists), so the handler does not re-check. On `Ok`, binds the
//       freshly-created admin's session immediately so the bootstrap window
//       routes into the app without a second login round-trip. Returns only
//       the `SessionDTO` slice — the IPC contract for this channel
//       intentionally does not surface the full `UserDTO`.
//
// Why these three are public from the router's perspective:
//
//   `auth:login` and `setup:createInitialAdmin` cannot be gated by a session
//   because no session exists yet. `auth:logout` is listed public in
//   design.md > "Process and IPC contract" so a renderer with no live
//   server-side binding (process restart, sender id reused) can still
//   request a clean teardown. The static RBAC matrix
//   (`src/main/permission/matrix.ts`) lists `auth:login` and `auth:logout`
//   under `ALL_ROLES` and `setup:createInitialAdmin` under the empty role
//   set as defence-in-depth — but with `requiresAuth: false` set here the
//   matrix is bypassed entirely (see `runHandler` in `router.ts`).
//
// Validates: Requirements 1.1, 1.2, 1.4, 1.6.

import { sessionStore } from '@main/auth/session-store.js';
import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { AuthService } from '@main/services/auth.service.js';
import { Ok } from '@shared/result.js';

import type { Session } from '@main/auth/session-store.js';
import type { SessionDTO } from '@shared/ipc-contract.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert the cross-process `SessionDTO` into the in-memory `Session`
 * record consumed by the IPC router middleware. The two shapes differ
 * only in that `Session` carries a `createdAt: Date` (kept server-side
 * for future telemetry / forced-relogin policies) where `SessionDTO`
 * does not — generating it here keeps the wire shape minimal.
 */
function toSession(dto: SessionDTO): Session {
  return {
    userId: dto.userId,
    role: dto.role,
    sessionId: dto.sessionId,
    createdAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `auth:login` handler. Public (`requiresAuth: false`) — there is no
 * pre-existing session to authenticate the call. The service collapses
 * unknown-username and wrong-password paths into a single
 * `Err('UNAUTHENTICATED')` (defence against username enumeration); the
 * handler forwards that envelope unchanged. On success the freshly-minted
 * session is bound to `ctx.senderId` so the next IPC call from the same
 * renderer satisfies the auth middleware.
 */
const loginHandler: HandlerFn<'auth:login'> = async (req, ctx) => {
  const result = await AuthService.login(req.username, req.password);
  if (!result.ok) {
    return result;
  }
  sessionStore.bind(ctx.senderId, toSession(result.value));
  return Ok(result.value);
};

/**
 * `auth:logout` handler. Public so a renderer with no live binding can
 * still request a teardown. Delegates to `AuthService.logout(senderId)`
 * which clears the binding via `sessionStore.clear`; idempotent on an
 * unknown sender id, so a double-fire from the renderer is harmless.
 */
const logoutHandler: HandlerFn<'auth:logout'> = async (_req, ctx) => {
  return AuthService.logout(ctx.senderId);
};

/**
 * `setup:createInitialAdmin` handler. Public; the
 * `admin_already_exists` gate lives in the service so this handler stays
 * a thin adapter. On `Ok`, the freshly-created admin's session is bound
 * to the bootstrap window's sender id so the app routes directly into
 * the home screen without a second round-trip through `auth:login`.
 *
 * The IPC contract for this channel returns `SessionDTO` only — the
 * service's richer `CreateInitialAdminResult` (with `user: UserDTO`) is
 * narrowed here so the wire response stays minimal.
 */
const setupCreateInitialAdminHandler: HandlerFn<'setup:createInitialAdmin'> = async (req, ctx) => {
  const result = await AuthService.createInitialAdmin(req.username, req.password);
  if (!result.ok) {
    return result;
  }
  sessionStore.bind(ctx.senderId, toSession(result.value.sessionDTO));
  return Ok(result.value.sessionDTO);
};

/**
 * `setup:isRequired` handler. Public, side-effect-free probe consulted
 * by the renderer on every app start (Phase 3 task 3.4) to decide
 * whether to render the setup screen before login. Returns
 * `{ required: true }` iff no Admin user exists.
 *
 * Implemented as a thin wrapper around `AuthService.hasAnyAdmin()`:
 * the service already encapsulates the "missing seeded role row →
 * treat as no admins" branch (so a partially-seeded database does
 * not deadlock first-run), so this handler does not retry or
 * massage the result.
 *
 * Validates: Requirements 1.6, 14.2.
 */
const setupIsRequiredHandler: HandlerFn<'setup:isRequired'> = async () => {
  const hasAdmin = await AuthService.hasAnyAdmin();
  return Ok({ required: !hasAdmin });
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every auth-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`) before
 * `bindIpcHandlers(ipcMain)`. Idempotent: re-registering the same channel
 * replaces the previous entry (useful for HMR during dev), so calling this
 * twice in tests is safe.
 */
export function registerAuthHandlers(): void {
  registerHandler('auth:login', { requiresAuth: false }, loginHandler);
  registerHandler('auth:logout', { requiresAuth: false }, logoutHandler);
  registerHandler('setup:createInitialAdmin', { requiresAuth: false }, setupCreateInitialAdminHandler);
  registerHandler('setup:isRequired', { requiresAuth: false }, setupIsRequiredHandler);
}

// Exported for unit tests in `tests/unit/main/ipc/handlers/auth.test.ts`
// so the handler functions can be exercised directly without driving the
// full router. Production code should always go through `registerAuthHandlers`.
export const __testables = Object.freeze({
  loginHandler,
  logoutHandler,
  setupCreateInitialAdminHandler,
  setupIsRequiredHandler,
  toSession,
});
