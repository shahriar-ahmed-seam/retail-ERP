// src/main/ipc/handlers/backup.ts
//
// IPC handlers for the backup channel group (Phase 11, task 11.2 wiring).
//
// Wires two channels into the router via the exported
// `registerBackupHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this alongside the other
// `register*Handlers()` entries so the router is fully populated
// before Electron exposes the IPC surface to renderers.
//
// Channels (both Admin-only per the static RBAC matrix —
// `src/main/permission/matrix.ts`):
//
//   - `backup:now`     Forwards directly to
//                      `BackupService.takeSnapshot()`. Returns
//                      `Ok({ path })` on success or the service's
//                      `Err('INTERNAL', ...)` envelope on failure.
//                      The handler does not pass `userDataDir` —
//                      production resolves it lazily via Electron's
//                      `app.getPath('userData')` (see
//                      `backup.service.ts > resolveUserDataDir`).
//
//   - `backup:restore` Stub returning `Err('INTERNAL', { reason:
//                      'NOT_IMPLEMENTED' })`. The full restore +
//                      replay flow lives in tasks 11.6 + 11.6.1 and
//                      is intentionally out of scope for this batch.
//                      Wiring the channel as a stub here — rather
//                      than leaving it unregistered — means the
//                      Electron binding loop attaches it to
//                      `ipcMain.handle` and the renderer sees a
//                      well-formed `Err(...)` envelope instead of
//                      an `IPC channel "backup:restore" not
//                      registered` error if the future UI calls it
//                      prematurely.
//
// Validates: Requirements 8.2, 8.4, 10.1, 10.2.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { BackupService } from '@main/services/backup.service.js';
import { Err } from '@shared/result.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `backup:now` handler. Admin-only by RBAC; cashiers see
 * `Err('FORBIDDEN')` from the router and an `rbac.deny` audit row
 * is written before this handler runs (Req 8.4).
 *
 * Same-day re-run policy: `BackupService.takeSnapshot` overwrites
 * the existing `shop-YYYY-MM-DD.db` file when the operator clicks
 * "Backup now" twice on the same day. Design.md > "Snapshot model"
 * keeps the daily naming convention and treats the manual trigger
 * as a deliberate override of the automatic daily run.
 */
const nowHandler: HandlerFn<'backup:now'> = async () => {
  return BackupService.takeSnapshot();
};

/**
 * `backup:restore` handler — stub.
 *
 * The full restore + journal replay flow is the responsibility of
 * Phase 11 tasks 11.6 + 11.6.1. Until those land we return a
 * structured `INTERNAL` envelope with `reason: 'NOT_IMPLEMENTED'` so
 * any premature renderer call surfaces a clear "feature not yet
 * available" message rather than an opaque failure.
 *
 * The handler is registered (rather than left unbound) so:
 *   - the Electron binding loop attaches it to `ipcMain.handle`,
 *   - the static IPC contract type stays satisfied by the router,
 *   - the `rbac.deny` audit row fires for cashiers attempting to
 *     trigger a restore (the matrix already pins the channel to
 *     Admin-only).
 */
const restoreHandler: HandlerFn<'backup:restore'> = (_req, _ctx) =>
  Promise.resolve(Err('INTERNAL', { reason: 'NOT_IMPLEMENTED' }));

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every backup-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerBackupHandlers(): void {
  registerHandler('backup:now', {}, nowHandler);
  registerHandler('backup:restore', {}, restoreHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/backup.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerBackupHandlers`.
export const __testables = Object.freeze({
  nowHandler,
  restoreHandler,
});
