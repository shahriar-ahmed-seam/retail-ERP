import { join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { sessionStore } from '@main/auth/session-store.js';
import { wireWindowSessionLifecycle } from '@main/auth/window-lifecycle.js';
import { connect, disconnect } from '@main/db/index.js';
import {
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
} from '@main/ipc/handlers/index.js';
import { bindIpcHandlers } from '@main/ipc/index.js';
import { AuthService } from '@main/services/auth.service.js';
import { BackupService } from '@main/services/backup.service.js';
import { runIntegrityCheck } from '@main/services/integrity.js';
import { startSchedulers, stopSchedulers } from '@main/services/scheduler.js';

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

void app.whenReady().then(async () => {
  await bootstrapMain();
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
