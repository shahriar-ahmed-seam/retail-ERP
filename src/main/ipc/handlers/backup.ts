// src/main/ipc/handlers/backup.ts
//
// IPC handlers for the backup channel group.
//
// Wires three channels into the router via the exported
// `registerBackupHandlers()` function. The bootstrap in
// `src/main/index.ts` calls this alongside the other
// `register*Handlers()` entries so the router is fully populated
// before Electron exposes the IPC surface to renderers.
//
// Channels (all Admin-only per the static RBAC matrix —
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
//   - `backup:list`    Enumerates every `shop-YYYY-MM-DD.db` file
//                      under `<userData>/backups/` so the backup UI
//                      panel can render the snapshot list (Phase 11
//                      task 11.7). Returns rows sorted newest-first.
//
//   - `backup:restore` Validates the requested path, drives the
//                      restore + journal replay flow via
//                      `BackupService.restoreSnapshot`, and returns
//                      the replay telemetry (`{ batchCount,
//                      appliedCount }`) so the UI can show the
//                      operator how many post-snapshot events were
//                      re-applied.
//
// Validates: Requirements 8.2, 8.4, 10.1, 10.2, 10.6, 11.3, 16.8.

import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import { BackupService } from '@main/services/backup.service.js';
import { Ok } from '@shared/result.js';

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
 * `backup:list` handler. Admin-only by RBAC. Reads the backups
 * directory and surfaces every `shop-YYYY-MM-DD.db` file's metadata
 * (path, mtime, size) so the renderer can drive the snapshot
 * picker. The service returns rows sorted newest-first; the
 * handler forwards them verbatim.
 */
const listHandler: HandlerFn<'backup:list'> = async () => {
  return BackupService.listSnapshots();
};

/**
 * `backup:restore` handler. Admin-only by RBAC. Drives the full
 * restore + replay flow: validates the path lies inside the
 * backups directory, disconnects Prisma, copies the snapshot over
 * shop.db, reopens the connection, and replays the journal forward
 * from the snapshot's recorded timestamp.
 *
 * Returns `Ok({ replayed })` carrying the replay telemetry
 * (`{ batchCount, appliedCount }`) so the UI can show how many
 * post-snapshot events were re-applied, or the service's
 * `Err('INTERNAL', ...)` envelope on failure.
 */
const restoreHandler: HandlerFn<'backup:restore'> = async (req) => {
  const result = await BackupService.restoreSnapshot({ path: req.path });
  if (!result.ok) return result;
  return Ok({ replayed: result.value.replayed });
};

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
  registerHandler('backup:list', {}, listHandler);
  registerHandler('backup:restore', {}, restoreHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/backup.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerBackupHandlers`.
export const __testables = Object.freeze({
  nowHandler,
  listHandler,
  restoreHandler,
});
