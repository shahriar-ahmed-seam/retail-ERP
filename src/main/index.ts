import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { sessionStore } from '@main/auth/session-store.js';
import { wireWindowSessionLifecycle } from '@main/auth/window-lifecycle.js';
import { connect, disconnect } from '@main/db/index.js';
import {
  registerAuthHandlers,
  registerCategoriesHandlers,
  registerInventoryHandlers,
  registerPosHandlers,
  registerProductsHandlers,
  registerPurchasesHandlers,
  registerReportsHandlers,
  registerSuppliersHandlers,
} from '@main/ipc/handlers/index.js';
import { bindIpcHandlers } from '@main/ipc/index.js';

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
  registerAuthHandlers();
  registerCategoriesHandlers();
  registerProductsHandlers();
  registerInventoryHandlers();
  registerReportsHandlers();
  registerSuppliersHandlers();
  registerPurchasesHandlers();
  registerPosHandlers();
  // Future handler groups (pos:finalize in task 7.4, …) plug in here.
  bindIpcHandlers(ipcMain);
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
  sessionStore.clearAll();
  // Best-effort; rejection here would only delay quit and there is no
  // useful recovery surface during shutdown.
  void disconnect();
});
