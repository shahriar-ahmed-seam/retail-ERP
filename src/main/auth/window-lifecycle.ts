// src/main/auth/window-lifecycle.ts
//
// Per-window session lifecycle wiring (Phase 3, task 3.5).
//
// Validates: Requirements 1.4, 1.5.
//
// The IPC router middleware keys sessions by the renderer's `WebContents.id`
// (see `src/main/auth/session-store.ts`). Two events MUST clear the binding
// for a given window so a stale session never authorizes a fresh renderer
// instance:
//
//   1. `webContents.did-start-loading` — fires on every renderer reload
//      (Ctrl+R, programmatic `location.reload()`, navigation, devtools
//      "Reload Frame"). Clearing here forces the renderer back through
//      `auth:login` even when Electron reuses the same WebContents id
//      across the reload (Req 1.4, 1.5).
//
//   2. `BrowserWindow.closed` — fires when the user closes the window.
//      The app-level `before-quit` hook already calls `clearAll`, but a
//      multi-window deployment (or a single window that closes without
//      quitting on macOS) still needs its binding torn down.
//
// Why a separate module instead of inlining in `src/main/index.ts`?
//
//   - The original inline version read `win.webContents.id` *inside* the
//     `'closed'` handler. By the time `'closed'` fires, the underlying
//     `WebContents` has been destroyed; accessing properties on it can
//     throw `Object has been destroyed`. Capturing the id once at wire
//     time, before any teardown, removes that hazard.
//   - Pulling the wiring out behind a small interface (`BrowserWindowLike`,
//     `SessionStoreLike`) lets the unit suite drive it with plain
//     EventEmitter-style stubs without needing the Electron runtime.

/**
 * Minimal contract the lifecycle wiring needs from the session store.
 * Matches the `clear` signature exported by `session-store.ts`; declared
 * here so this module does not import the Electron-side implementation
 * just to reference its types (and so tests can substitute a stub).
 */
export interface SessionStoreLike {
  clear(senderId: number): void;
}

/**
 * Subset of the `Electron.WebContents` surface the wiring touches.
 * Restricting the type makes the test stubs trivial to write and prevents
 * the helper from quietly growing a dependency on richer WebContents APIs.
 */
export interface WebContentsLike {
  readonly id: number;
  on(event: 'did-start-loading', listener: () => void): unknown;
}

/**
 * Subset of the `Electron.BrowserWindow` surface the wiring touches.
 * Same rationale as `WebContentsLike`.
 */
export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  on(event: 'closed', listener: () => void): unknown;
}

/**
 * Wire the two per-window session-clearing hooks (`did-start-loading` and
 * `closed`) for a single `BrowserWindow`.
 *
 * The `senderId` is captured at call time and closed over by both
 * listeners. This is deliberate:
 *
 *   - `did-start-loading` could read `win.webContents.id` directly and
 *     would be safe — but reading it there too keeps the two clears
 *     symmetric and means a future change to one cannot accidentally
 *     diverge from the other.
 *
 *   - `closed` MUST NOT read `win.webContents.id` lazily: by the time
 *     `closed` fires, the WebContents is destroyed and accessing its
 *     properties can throw. The captured value is the only safe option.
 *
 * The helper attaches one listener to each event and returns nothing —
 * detaching is implicit when the window is garbage-collected, which is
 * the same lifetime as the captured `senderId` itself.
 */
export function wireWindowSessionLifecycle(
  win: BrowserWindowLike,
  store: SessionStoreLike,
): void {
  const senderId = win.webContents.id;

  // Forced re-login on renderer reload. Electron may reuse the same
  // sender id across a reload, so clearing here is the only signal that
  // forces the next IPC call back through the auth middleware.
  win.webContents.on('did-start-loading', () => {
    store.clear(senderId);
  });

  // Window close cleanup. Uses the captured `senderId` because the
  // WebContents is destroyed by the time this fires.
  win.on('closed', () => {
    store.clear(senderId);
  });
}
