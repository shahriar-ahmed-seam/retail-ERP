import { join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { sessionStore } from '@main/auth/session-store.js';
import { wireWindowSessionLifecycle } from '@main/auth/window-lifecycle.js';
import {
  ensureUserDb,
  runMigrations,
  type RunMigrationsResult,
} from '@main/bootstrap/index.js';
import { connect, disconnect } from '@main/db/index.js';
import {
  registerAuditHandlers,
  registerAuthHandlers,
  registerBackupHandlers,
  registerCategoriesHandlers,
  registerCustomersHandlers,
  registerInventoryHandlers,
  registerPosHandlers,
  registerProductsHandlers,
  registerPurchasesHandlers,
  registerReportsHandlers,
  registerSettingsHandlers,
  registerSuppliersHandlers,
  registerUsersHandlers,
} from '@main/ipc/handlers/index.js';
import { bindIpcHandlers } from '@main/ipc/index.js';
import { AuthService } from '@main/services/auth.service.js';
import { BackupService } from '@main/services/backup.service.js';
import { runIntegrityCheck } from '@main/services/integrity.js';
import { startSchedulers, stopSchedulers } from '@main/services/scheduler.js';
import {
  MIGRATION_PROGRESS_CHANNEL,
  type MigrationProgressEvent,
} from '@shared/migration.js';

/**
 * Electron main-process entry.
 *
 * Bootstrap sequence (Phase 3, task 3.2 wires the auth slice; later phases
 * will register additional handler groups before `bindIpcHandlers`):
 *
 *   1. Open the SQLite connection and apply PRAGMAs (`connect()`).
 *      Done before any handler can run so transactions executed inside
 *      handlers see WAL + foreign_keys ON from the first call.
 *   2. Register every IPC handler group via `register*Handlers()`. Each
 *      group calls `registerHandler(channel, opts, fn)` against the
 *      router's in-memory registry.
 *   3. Bind the populated registry to Electron's `ipcMain.handle` exactly
 *      once, via `bindIpcHandlers(ipcMain)`. After this point new handler
 *      registrations will not be reachable from the renderer.
 *   4. Create the BrowserWindow.
 *
 * Shutdown:
 *   - `clearAll` is invoked on `before-quit` and on every window close so
 *     stale session bindings do not survive a renderer reload (Req 1.4, 1.5).
 *   - `disconnect()` runs on `before-quit` so the SQLite file handle is
 *     released cleanly before the process exits.
 */

let bootstrapped = false;

/**
 * One-shot bootstrap. Idempotent so HMR-driven re-runs of `whenReady`
 * (which can fire on `activate` after every window has closed on macOS)
 * do not register handlers twice. `registerHandler` itself replaces
 * existing entries, so a duplicate call is harmless — but we still skip
 * to avoid the audit/log noise of re-binding `ipcMain.handle`.
 */
async function bootstrapMain(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  await connect();

  // Phase 11 task 11.6 — startup recovery flow. Run
  // `PRAGMA integrity_check` BEFORE the IPC surface is bound. On
  // non-`ok`, prompt the operator (Admin auth required) and either
  // copy the latest snapshot over `shop.db` + replay the journal,
  // or refuse to start. The prompt runs through Electron's modal
  // dialog API so it works before any BrowserWindow exists. Tests
  // inject `__bootstrapDeps.recoveryPrompt` to drive the flow
  // headlessly.
  const recoveryHandled = await runStartupRecoveryFlow();
  if (!recoveryHandled) {
    app.quit();
    return;
  }

  registerAuthHandlers();
  registerCategoriesHandlers();
  registerProductsHandlers();
  registerInventoryHandlers();
  registerReportsHandlers();
  registerSuppliersHandlers();
  registerCustomersHandlers();
  registerPurchasesHandlers();
  registerPosHandlers();
  registerSettingsHandlers();
  registerBackupHandlers();
  registerAuditHandlers();
  registerUsersHandlers();
  // Future handler groups (pos:finalize in task 7.4, …) plug in here.
  bindIpcHandlers(ipcMain);

  // Phase 11 tasks 11.2 + 11.2.1 — start the daily-snapshot recheck
  // interval, the 60-min WAL checkpoint fallback, and the weekly
  // VACUUM/ANALYZE cron after the IPC surface is fully bound. The
  // schedulers are stopped on `before-quit` below.
  startSchedulers();
}

// ---------------------------------------------------------------------------
// Startup recovery (Phase 11, task 11.6)
// ---------------------------------------------------------------------------

/**
 * Outcome of the recovery prompt. The bootstrap branches on this
 * to decide whether to proceed with normal startup, run a restore,
 * or quit.
 */
export type RecoveryDecision =
  | { readonly action: 'continue' }
  | { readonly action: 'cancel' }
  | { readonly action: 'restore'; readonly username: string; readonly password: string };

/**
 * Injection seam for the recovery prompt. Production wires
 * `defaultRecoveryPrompt`, which uses Electron's modal `dialog`
 * API + a tiny modal `BrowserWindow` for credential capture.
 * Tests inject a deterministic implementation so the flow runs
 * headlessly.
 */
export interface BootstrapDeps {
  readonly recoveryPrompt?: (details: string) => Promise<RecoveryDecision>;
}

let bootstrapDeps: BootstrapDeps = {};

/** Test-only injector — overrides the recovery prompt callback. */
export function setBootstrapDeps(deps: BootstrapDeps): void {
  bootstrapDeps = deps;
}

/** Test-only resetter — restores the production prompt. */
export function resetBootstrapDeps(): void {
  bootstrapDeps = {};
}

/**
 * Default recovery prompt — Electron `dialog.showMessageBox`. When
 * the operator clicks "Restore", we open a tiny credentials prompt
 * (a modal `BrowserWindow` would be the long-form choice; for V1 we
 * use a follow-up `showMessageBox` that fires `prompt`-style only
 * if the host platform supports it). To stay portable on Electron's
 * modal API we use a JavaScript-driven prompt: the message box
 * captures the click, then a separate prompt window collects the
 * username + password.
 *
 * For V1 we keep the implementation simple by accepting that the
 * prompt currently only takes the operator's confirmation; the
 * username/password verification path runs `AuthService.login`
 * against credentials read from environment variables
 * (`KIRO_RECOVERY_USERNAME`, `KIRO_RECOVERY_PASSWORD`) when they
 * are set. This is a pragmatic V1 surface — a full credential
 * dialog UI lives behind the renderer-only setup screen, which is
 * not reachable during the recovery flow because the IPC surface
 * is not yet bound.
 */
async function defaultRecoveryPrompt(details: string): Promise<RecoveryDecision> {
  const choice = await dialog.showMessageBox({
    type: 'warning',
    title: 'Database integrity check failed',
    message:
      'The database failed an integrity check on startup. Restore the latest backup and replay the journal?',
    detail: details,
    buttons: ['Cancel', 'Restore from latest backup'],
    defaultId: 0,
    cancelId: 0,
  });

  if (choice.response === 0) {
    return { action: 'cancel' };
  }

  // V1 credential capture: read from env. Operator typically runs
  // a one-shot recovery launcher that sets these. A full dialog-
  // based prompt with input fields requires a dedicated modal
  // BrowserWindow which is out of scope for this task.
  const username = process.env.KIRO_RECOVERY_USERNAME ?? '';
  const password = process.env.KIRO_RECOVERY_PASSWORD ?? '';
  return { action: 'restore', username, password };
}

/**
 * Drive the startup recovery flow. Returns `true` when normal
 * startup may continue, `false` when the bootstrap should refuse
 * to start.
 *
 * Steps:
 *
 *   1. `runIntegrityCheck()` — single `PRAGMA integrity_check`.
 *      On `Ok({ ok: true })` we return immediately (normal start).
 *      Everything else (corruption detected OR check itself
 *      failed) opens the recovery prompt.
 *
 *   2. Recovery prompt — operator either cancels (refuse to
 *      start) or accepts. On accept we verify the supplied admin
 *      credentials via `AuthService.login`. If they fail we log
 *      and refuse to start (defence-in-depth: a corrupted DB
 *      could let an attacker side-step auth otherwise).
 *
 *   3. Restore — pick the most-recent snapshot via
 *      `BackupService.listSnapshots`, then drive
 *      `BackupService.restoreSnapshot({ path })`. The service
 *      handles the disconnect → copyFile → reconnect → replay
 *      sequence.
 *
 * On any failure we log via `console.error` and return `false` so
 * the caller (`bootstrapMain`) can quit the app.
 */
async function runStartupRecoveryFlow(): Promise<boolean> {
  let integrityResult;
  try {
    integrityResult = await runIntegrityCheck();
  } catch (err) {
    console.error('[bootstrap] integrity check threw', err);
    return false;
  }

  if (integrityResult.ok && integrityResult.value.ok) {
    return true;
  }

  const details =
    integrityResult.ok && !integrityResult.value.ok
      ? integrityResult.value.details
      : 'integrity check itself failed';
  console.error(`[bootstrap] integrity check failed: ${details}`);

  const prompt = bootstrapDeps.recoveryPrompt ?? defaultRecoveryPrompt;

  let decision: RecoveryDecision;
  try {
    decision = await prompt(details);
  } catch (err) {
    console.error('[bootstrap] recovery prompt threw', err);
    return false;
  }

  if (decision.action === 'cancel' || decision.action === 'continue') {
    if (decision.action === 'continue') {
      console.warn('[bootstrap] recovery prompt requested continue without restore');
      return true;
    }
    console.warn('[bootstrap] recovery cancelled by operator; refusing to start');
    return false;
  }

  // Verify Admin credentials before performing the destructive
  // copy. The integrity check already failed so the auth lookup
  // may itself throw; we treat any failure as "credentials not
  // valid → refuse to start".
  let authOk = false;
  try {
    const loginResult = await AuthService.login(decision.username, decision.password);
    if (loginResult.ok && loginResult.value.role === 'Admin') {
      authOk = true;
    }
  } catch (err) {
    console.error('[bootstrap] admin auth lookup during recovery threw', err);
  }
  if (!authOk) {
    console.error('[bootstrap] recovery cancelled — admin credentials not verified');
    return false;
  }

  // Pick the latest snapshot.
  const list = await BackupService.listSnapshots();
  if (!list.ok) {
    console.error('[bootstrap] recovery cancelled — listSnapshots failed', list.error);
    return false;
  }
  const latest = list.value.rows[0];
  if (latest === undefined) {
    console.error('[bootstrap] recovery cancelled — no snapshots available to restore from');
    return false;
  }

  const restore = await BackupService.restoreSnapshot({ path: latest.path });
  if (!restore.ok) {
    console.error('[bootstrap] recovery restore failed', restore.error);
    return false;
  }

  console.warn(
    `[bootstrap] recovery completed — replayed ${restore.value.replayed.appliedCount} ` +
      `entries across ${restore.value.replayed.batchCount} batches`,
  );
  return true;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // Frameless chrome (Discord / WhatsApp / VS Code style): the OS
    // title bar is hidden and the renderer paints its own. The
    // renderer's `<TitleBar>` component declares a CSS-driven drag
    // region (`-webkit-app-region: drag`) so the user can still move
    // the window by the top strip, and three custom buttons (min /
    // max-restore / close) call window-control IPC channels exposed
    // by the preload bridge below.
    //
    // `titleBarStyle: 'hidden'` is the macOS counterpart — it hides
    // the title bar but keeps the traffic-light overlay buttons
    // visible by default, so macOS users get the platform-native
    // close/minimize/maximize controls floating over our custom
    // title bar. `titleBarOverlay` adjusts the inset so our buttons
    // do not collide with them.
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('ready-to-show', () => {
    win.show();
  });

  // Maximized-state notifier so the renderer can swap the
  // maximize-button glyph between "maximize" and "restore" without
  // polling. Sent on every transition; the renderer ignores
  // duplicates by comparing against its local state.
  const sendMaximizedState = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.send('window:maximizedState', { maximized: win.isMaximized() });
  };
  win.on('maximize', sendMaximizedState);
  win.on('unmaximize', sendMaximizedState);
  win.webContents.once('did-finish-load', sendMaximizedState);

  // Per-window session lifecycle hooks (Phase 3, task 3.5):
  //   - `did-start-loading` clears the binding so a renderer reload
  //     (Ctrl+R, programmatic) forces the user back through `auth:login`,
  //     even when Electron reuses the same WebContents id.
  //   - `closed` clears the binding for the captured sender id; the id is
  //     captured eagerly inside the helper because reading
  //     `win.webContents.id` after `closed` fires can throw "Object has
  //     been destroyed".
  // The app-level `before-quit` below calls `clearAll` as a final sweep
  // for the multi-window case (Req 1.4, 1.5).
  wireWindowSessionLifecycle(win, sessionStore);

  // electron-vite injects ELECTRON_RENDERER_URL when running in dev mode so
  // the renderer is loaded from the Vite dev server with HMR. In production
  // it is undefined and we load the bundled HTML from disk.
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ---------------------------------------------------------------------------
// Frameless window controls
// ---------------------------------------------------------------------------

/**
 * Register window-control channels for the custom title bar
 * (`window:minimize`, `window:maximize`, `window:close`).
 *
 * The application uses a frameless `BrowserWindow` (`frame: false`)
 * so the renderer paints its own title bar. The native min/max/close
 * buttons no longer exist, so the renderer dispatches these IPC
 * messages when the user clicks the custom buttons.
 *
 * These channels are pre-auth — the login window must be closeable —
 * and one-way fire-and-forget, so we use `ipcMain.on` (no Result
 * envelope). The handlers look up the source window via
 * `BrowserWindow.fromWebContents(event.sender)`; if the lookup
 * fails (window already destroyed) the handler is a no-op.
 *
 * Registered once during bootstrap, idempotent because the bootstrap
 * itself is idempotent.
 */
function registerWindowControls(): void {
  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null || win.isDestroyed()) return;
    if (win.isMinimizable()) win.minimize();
  });
  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null || win.isDestroyed()) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else if (win.isMaximizable()) {
      win.maximize();
    }
  });
  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === null || win.isDestroyed()) return;
    win.close();
  });
}

// ---------------------------------------------------------------------------
// First-run migration window (Phase 16, tasks 16.2 + 16.7)
// ---------------------------------------------------------------------------

/**
 * Open a dedicated full-screen migration progress `BrowserWindow`
 * loading the renderer bundle with `?migration=true`. The renderer
 * entry detects the query string and mounts `<MigrationProgressPage />`
 * directly, bypassing the auth provider, the router, and every
 * feature module so no protected surface is reachable while
 * migrations run (Req 14.9).
 *
 * Keeping the window construction here (rather than inside a helper
 * module) is deliberate: the migration window is the only window the
 * application opens before the IPC surface is bound. Reusing
 * `createWindow()` would also wire the session-clearing hooks, which
 * are pointless when no session can exist yet.
 */
function createMigrationProgressWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 400,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Core Retail ERP — Updating database',
    // Frameless to match the main window. The migration page renders
    // its own minimal close-only chrome inline.
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.removeMenu();
  win.on('ready-to-show', () => {
    win.show();
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void win.loadURL(`${devServerUrl}?migration=true`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { migration: 'true' },
    });
  }

  return win;
}

/**
 * Send a migration progress event to the open migration window.
 * No-ops if the window has been destroyed (e.g. operator forced
 * close mid-migration); the bootstrap logs the underlying error
 * and continues to its terminal state.
 */
function sendMigrationProgress(
  win: BrowserWindow,
  event: MigrationProgressEvent,
): void {
  if (win.isDestroyed()) return;
  win.webContents.send(MIGRATION_PROGRESS_CHANNEL, event);
}

/**
 * Resolve the bundled DB template path. In a packaged Electron app
 * `process.resourcesPath` points at the `resources/` directory under
 * the installed application; in dev (`npm run dev`) it points at
 * Electron's own resource directory, so we fall back to the repo
 * root's `resources/shop.db.template`.
 */
function resolveTemplatePath(): string {
  // Packaged: `process.resourcesPath` is the `resources/` directory under
  // the installed application, and `extraResources` (electron-builder.yml)
  // mapped `resources/shop.db.template` to `<resourcesPath>/shop.db.template`.
  if (app.isPackaged) {
    return join(process.resourcesPath, 'shop.db.template');
  }
  // Dev: `process.resourcesPath` points at Electron's own resource folder
  // (e.g. `node_modules/electron/dist/resources/`), which never contains
  // our template. Resolve against the repo root so a clean checkout that
  // ran `npm run db:template` finds the file.
  return join(app.getAppPath(), 'resources', 'shop.db.template');
}

/**
 * Run the first-run database flow inside the migration progress
 * window. Returns `true` when migrations completed and the main
 * bootstrap may proceed; `false` when the bootstrap should refuse
 * to start (operator-visible error already shown in the migration
 * window).
 *
 *   1. Resolve `<userData>` and the bundled template path.
 *   2. Open the migration window.
 *   3. Wait for `did-finish-load` so the renderer's
 *      `setup:migrationProgress` listener is attached before any
 *      events are emitted (otherwise the first `preparing` event
 *      races the listener registration and is dropped).
 *   4. `ensureUserDb` — copy the template if no DB exists.
 *   5. `runMigrations` — `prisma migrate deploy` against the
 *      user-data DB, piping progress to the window.
 *   6. On success: emit `done`, brief settle delay, destroy the
 *      window, and return true.
 *   7. On failure: emit `error`, leave the window open showing the
 *      recovery prompt copy, and return false.
 *
 * The `DATABASE_URL` env is set to `file:<userData>/shop.db` for
 * the lifetime of the process so the singleton Prisma client
 * (constructed in `bootstrapMain` via `connect()`) opens the
 * user-data DB rather than `prisma/dev.db`.
 *
 * Validates: Requirements 14.1, 14.2, 14.8, 14.9.
 */
async function runFirstRunBootstrap(): Promise<boolean> {
  // Dev mode (`npm run dev`): the developer already ran
  // `prisma migrate dev` against `prisma/dev.db`, `.env` already
  // points `DATABASE_URL` at that file, and the seed has been
  // applied. The first-run bootstrap is a packaged-installer
  // concern (Phase 16 task 16.2) — running it in dev would
  // overwrite `<userData>/shop.db` with the bundled template on
  // every launch and confuse the developer's working state.
  // Skip it cleanly and let `bootstrapMain()` open Prisma against
  // whatever DATABASE_URL the `.env` provided.
  if (!app.isPackaged) {
    return true;
  }

  const userDataDir = app.getPath('userData');
  const templatePath = resolveTemplatePath();
  const repoCwd = app.getAppPath();

  let dbPath: string;
  try {
    const ensured = ensureUserDb({ userDataDir, templatePath });
    dbPath = ensured.dbPath;
    if (ensured.copied) {
      console.warn(
        `[bootstrap] copied bundled template to ${dbPath} (first run)`,
      );
    }
  } catch (err) {
    console.error('[bootstrap] ensureUserDb failed', err);
    // No window to surface this in yet — fail hard.
    await dialog.showMessageBox({
      type: 'error',
      title: 'Core Retail ERP — Failed to start',
      message: 'Could not prepare the database file.',
      detail: err instanceof Error ? err.message : String(err),
      buttons: ['Quit'],
    });
    return false;
  }

  // Point Prisma at the user-data DB. The singleton constructed by
  // `@main/db/prisma.ts` reads `DATABASE_URL` at client-construction
  // time; setting it before `bootstrapMain()` is what makes the
  // application talk to the user's data file rather than the
  // committed `prisma/dev.db`.
  const databaseUrl = `file:${dbPath.replace(/\\/g, '/')}`;
  process.env.DATABASE_URL = databaseUrl;

  const win = createMigrationProgressWindow();

  // Wait for the renderer to attach its progress listener before
  // we emit any events. `did-finish-load` fires after the page's
  // `useEffect` registrations have run.
  await new Promise<void>((resolve) => {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        resolve();
      });
    } else {
      resolve();
    }
  });

  let migrationResult: RunMigrationsResult;
  try {
    migrationResult = await runMigrations({
      databaseUrl,
      cwd: repoCwd,
      onProgress: (event) => {
        sendMigrationProgress(win, event);
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[bootstrap] migration runner threw', err);
    sendMigrationProgress(win, { phase: 'error', message });
    return false;
  }

  if (migrationResult.exitCode !== 0) {
    const message =
      migrationResult.stderr.trim().length > 0
        ? migrationResult.stderr.trim()
        : `prisma migrate deploy exited with status ${migrationResult.exitCode}`;
    console.error(`[bootstrap] migration failed: ${message}`);
    sendMigrationProgress(win, { phase: 'error', message });
    return false;
  }

  sendMigrationProgress(win, { phase: 'done' });

  // Brief settle so the operator sees the `Done` copy. 250 ms is
  // short enough not to annoy and long enough to read on a fresh
  // install.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 250);
  });

  if (!win.isDestroyed()) {
    win.destroy();
  }
  return true;
}

void app.whenReady().then(async () => {
  // Frameless title bar IPC must be registered before any window
  // opens — including the migration progress window — so the
  // custom min/max/close buttons work from the very first paint.
  registerWindowControls();

  // Phase 16, tasks 16.2 + 16.7 — first-run database bootstrap.
  // The migration progress `BrowserWindow` is the ONLY window the
  // user can see while migrations run; the main application window
  // is gated behind a clean migration result.
  const migrationOk = await runFirstRunBootstrap();
  if (!migrationOk) {
    // The migration window stays open showing the error copy; the
    // user can read the message and quit. We do NOT continue to the
    // main bootstrap because Prisma must not be opened against an
    // out-of-date schema (Req 14.9).
    return;
  }

  await bootstrapMain();
  // If `bootstrapMain` invoked `app.quit()` via the integrity-check
  // recovery flow, Electron is already shutting down; `createWindow`
  // is still safe to call (the existing pre-Phase-16 behaviour) but
  // any window it opens will be torn down immediately.
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Phase 11, tasks 11.2 + 11.2.1 — clear every registered scheduler
  // handle (daily-snapshot recheck, WAL checkpoint, weekly cron) so
  // a late tick after `disconnect()` cannot surface as an unhandled
  // rejection on a closed Prisma connection.
  stopSchedulers();
  sessionStore.clearAll();
  // Best-effort; rejection here would only delay quit and there is no
  // useful recovery surface during shutdown.
  void disconnect();
});
