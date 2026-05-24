// src/main/auth/session-store.ts
//
// In-memory session store for the main-process IPC router (Phase 2, task 2.5).
//
// Sessions are bound to a renderer's `WebContents.id` (Electron's per-window
// numeric handle). The IPC router reads `event.sender.id` on every invoke,
// looks the session up here, and uses it to drive the auth + RBAC + audit
// middleware described in design.md > "Process and IPC contract":
//
//     const session = sessionStore.get(_e.sender.id);
//     if (handler.requiresAuth && !session) return Err('UNAUTHENTICATED');
//     if (!Permission.allows(session.role, channel)) return Err('FORBIDDEN');
//
// Why in-memory and not persisted?
//   - The app is single-tenant on one workstation. There is no horizontal
//     scaling to support, so a process-local `Map` is sufficient.
//   - Sessions MUST NOT survive a renderer reload (Req 1.4, 1.5): reload
//     re-creates the WebContents with a fresh id, the old binding is
//     orphaned, and the user is forced back through `auth:login`. An
//     in-memory `Map` gives this for free; a persisted store would have to
//     re-implement that invariant.
//   - On `app.before-quit` and on every window close, the bootstrap
//     (Phase 3, task 3.5) calls `clearAll()` so the next launch starts from
//     a clean state.
//
// Why a numeric key?
//   `WebContents.id` is `number` in Electron's typings. Using a number as
//   the `Map` key avoids `String(senderId)` round-trips on the hot path
//   (every IPC call calls `get` once).
//
// Validates: Requirements 1.4, 1.5.

import type { SessionRole } from '@shared/ipc-contract.js';

/**
 * The renderer's `WebContents.id` (an Electron-assigned non-negative
 * integer). Aliased so call sites read as intent rather than primitive.
 */
export type SenderId = number;

/**
 * Authenticated session record carried by the IPC router middleware.
 *
 * The shape is fixed by design.md > "Session store" and the auth flow in
 * task 3.1: `userId` and `role` drive RBAC, `sessionId` is the public
 * handle returned to the renderer (for `auth:logout`), and `createdAt` is
 * stored so future telemetry / "force re-login after N hours" policies can
 * read it without changing the shape.
 *
 * Treated as immutable by every consumer; rebinding under the same
 * `senderId` (e.g. on a username change) goes through `bind()`, which
 * replaces the entry wholesale rather than mutating it.
 */
export interface Session {
  readonly userId: string;
  readonly role: SessionRole;
  readonly sessionId: string;
  readonly createdAt: Date;
}

/**
 * Backing map. Module-private so callers cannot iterate or mutate the
 * store directly — every read/write goes through the four exported
 * functions (which keeps the surface small enough that swapping the
 * implementation later, e.g. for an LRU cache or a TTL store, is a
 * one-file change).
 */
const sessions = new Map<SenderId, Session>();

/**
 * Bind a session to a renderer. Replaces any existing binding for the same
 * `senderId` — this is the path used both on `auth:login` (no prior
 * binding) and on `setup:createInitialAdmin` (the freshly-created admin is
 * logged in immediately, sharing the bootstrap window's sender id).
 *
 * O(1).
 */
export function bind(senderId: SenderId, session: Session): void {
  sessions.set(senderId, session);
}

/**
 * Look up the session for a renderer. Returns `undefined` when the
 * renderer has not authenticated, has logged out, or has been reloaded
 * (which orphans the binding under the old sender id).
 *
 * The IPC router middleware translates `undefined` into
 * `Err('UNAUTHENTICATED')` (design.md > "Process and IPC contract").
 *
 * O(1).
 */
export function get(senderId: SenderId): Session | undefined {
  return sessions.get(senderId);
}

/**
 * Clear the binding for a single renderer. Called on `auth:logout` and on
 * `BrowserWindow.closed` (Phase 3, task 3.5). Idempotent — clearing an
 * unknown sender is a no-op, which keeps the close handler simple even if
 * the user never logged in.
 *
 * O(1).
 */
export function clear(senderId: SenderId): void {
  sessions.delete(senderId);
}

/**
 * Clear every binding. Called on `app.before-quit` (Phase 3, task 3.5)
 * and from test fixtures that need to reset state between cases. Cheap
 * regardless of size: `Map.clear` is O(n) but in this app `n` is bounded
 * by the number of open windows (typically 1).
 */
export function clearAll(): void {
  sessions.clear();
}

/**
 * Convenience namespace mirroring the call style used in design.md
 * (`sessionStore.get(_e.sender.id)`). Re-exports the same four functions
 * as methods so callers can choose either the named-import style
 * (`import { get } from '@main/auth/session-store'`) or the namespace
 * style (`import { sessionStore } from '@main/auth/session-store'`)
 * depending on which reads better at the call site.
 */
export const sessionStore = Object.freeze({
  bind,
  get,
  clear,
  clearAll,
});
