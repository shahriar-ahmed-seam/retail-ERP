/**
 * Migration progress event contract (Phase 16, tasks 16.2 + 16.7).
 *
 * The first-run bootstrap (`src/main/bootstrap/first-run.ts`) emits
 * progress events to the migration progress `BrowserWindow` over a
 * dedicated unprivileged channel. The channel is intentionally
 * separate from `IpcContract`:
 *
 *   - It runs PRE-AUTH (no session exists yet, the IPC router is
 *     not bound). RBAC enforcement does not apply.
 *   - It is one-way main → renderer. The renderer never posts to
 *     this channel; it only subscribes via the preload bridge
 *     (`window.setupApi.onMigrationProgress`).
 *   - It must remain mountable before Prisma is opened against the
 *     user-data database (Req 14.9), so the channel surface lives
 *     in `@shared` rather than co-located with the IPC contract.
 *
 * Event shape:
 *
 *   - `phase: 'preparing'` — bootstrap has decided whether to copy
 *     the bundled `shop.db.template` and is about to launch the
 *     `prisma migrate deploy` subprocess. UI shows
 *     `Preparing database…`.
 *
 *   - `phase: 'applying'` — at least one migration is being applied.
 *     `current` and `total` are 1-based migration counts; UI shows
 *     `Applying migration N of M…` (where M is `total`).
 *
 *   - `phase: 'done'` — every migration has been applied. UI shows
 *     `Done` momentarily before the migration window is destroyed
 *     and the main window is created.
 *
 *   - `phase: 'error'` — the migration runner failed. The migration
 *     window switches to the recovery prompt copy (Phase 11 task
 *     11.6) without ever exposing the main window. `message` carries
 *     the human-readable error detail.
 *
 * Validates: Requirements 14.2, 14.9.
 */

/** Wire name for `webContents.send` and `ipcRenderer.on`. */
export const MIGRATION_PROGRESS_CHANNEL = 'setup:migrationProgress' as const;

/**
 * Discriminated union of the event payloads the migration window can
 * receive. The shape is kept stable across phases so a future
 * progress-bar change in the page doesn't require touching the main
 * process emitter.
 */
export type MigrationProgressEvent =
  | { readonly phase: 'preparing'; readonly message?: string }
  | {
      readonly phase: 'applying';
      readonly current: number;
      readonly total: number;
      readonly message?: string;
    }
  | { readonly phase: 'done'; readonly message?: string }
  | { readonly phase: 'error'; readonly message: string };

/** Convenience alias for the discriminator. */
export type MigrationPhase = MigrationProgressEvent['phase'];
