// src/preload/index.ts
//
// Preload script (Phase 2, task 2.6).
//
// The preload runs in an isolated context between the Electron main process
// and the renderer's Chromium sandbox. With the `BrowserWindow` configured
// for `contextIsolation: true`, `nodeIntegration: false`, and `sandbox:
// true` (see `src/main/index.ts`), the renderer has no direct access to
// Node, Electron, or the file system; the only surface it sees is the
// object exposed via `contextBridge.exposeInMainWorld('api', ...)` here.
//
// The bridge surface is fully typed against `IpcContract` (`src/shared/
// ipc-contract.ts`):
//
//   - One method per channel, generated from the runtime `IPC_CHANNELS`
//     constant. Adding a channel to `IpcContract` without adding it to
//     `IPC_CHANNELS` fails the compile-time exhaustiveness check in
//     `ipc-contract.ts`, so the bridge cannot silently drop a channel.
//
//   - Each method delegates to `ipcRenderer.invoke(channel, req)` and
//     returns the awaited `Result<IpcResponse<C>>` produced by the
//     main-process router. Because every IPC handler in
//     `src/main/ipc/router.ts` already returns a `Result` envelope (and
//     converts thrown exceptions to `Err('INTERNAL', ...)`), the renderer
//     never needs a `try/catch` around an IPC call.
//
//   - Channels whose request is `void` accept zero arguments at the
//     call site (`window.api['auth:logout']()`); the wrapper drops the
//     undefined payload before invoking. This matches the `Api` type's
//     conditional method signature.
//
// The renderer's global typing for `window.api` lives in
// `src/renderer/types/window.d.ts`, not in this file. Augmenting
// `globalThis.Window` from the preload would leak its types into the
// preload's own scope (which is not what consumers expect) and would not
// be visible to the renderer's tsconfig. Keeping the augmentation under
// `src/renderer/types/` keeps each tsconfig's scope clean.
//
// Validates: Requirement 1.5.

import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '@shared/ipc-contract';
import {
  MIGRATION_PROGRESS_CHANNEL,
  type MigrationProgressEvent,
} from '@shared/migration';

import type { Api, IpcChannel } from '@shared/ipc-contract';
import type { IpcRendererEvent } from 'electron';

/**
 * Build the typed `api` object by mapping every channel in
 * `IPC_CHANNELS` to a function that delegates to `ipcRenderer.invoke`.
 *
 * Why a generic delegate instead of 41 hand-written methods:
 *   - The list of channels is the single source of truth (`IpcContract`
 *     + `IPC_CHANNELS`). Hand-rolled methods would be a second source
 *     and could drift.
 *   - The compile-time exhaustiveness assertion in `ipc-contract.ts`
 *     guarantees every channel is in `IPC_CHANNELS`, so the loop below
 *     covers the full surface.
 *
 * Type narrowing: the loop builds an `Record<string, ...>` and we cast
 * the finished object to `Api` at the boundary. The cast is safe because
 * (a) every key written into the record is a `keyof IpcContract` (the
 * declared element type of `IPC_CHANNELS`), and (b) the value at each
 * key is a function with the right signature for that channel — the
 * renderer-side type-system view of `Api` is exactly what consumers
 * import in `src/renderer/lib/api.ts` (task 2.7).
 */
function buildApi(): Api {
  const surface: Record<string, (req?: unknown) => Promise<unknown>> = {};

  for (const channel of IPC_CHANNELS) {
    // Capture the channel in the closure so each method invokes the
    // correct route. Using `(channel: IpcChannel)` here keeps the type
    // information available to readers even though the value is only
    // forwarded as a string to `ipcRenderer.invoke`.
    const c: IpcChannel = channel;
    surface[channel] = async (req?: unknown) => {
      // `ipcRenderer.invoke` always serialises its second argument; for
      // `void`-request channels we forward `undefined`, which is treated
      // as an absent payload by the main-process router (handlers for
      // void channels ignore the request).
      return ipcRenderer.invoke(c, req);
    };
  }

  return surface as unknown as Api;
}

// Expose the bridge. With `contextIsolation: true` this becomes
// `window.api` in the renderer; with `contextIsolation: false` (which
// this app does NOT use) it would become a global on the same context as
// the page, defeating the isolation.
contextBridge.exposeInMainWorld('api', buildApi());

// ---------------------------------------------------------------------------
// `setupApi` — pre-auth bridge for the migration progress window
// ---------------------------------------------------------------------------
//
// The migration progress window (Phase 16 task 16.7) is shown BEFORE the
// IPC router is bound and BEFORE any user has authenticated. It still
// needs to receive progress events from the main-process bootstrap so
// the spinner copy can advance from `Preparing database…` through
// `Applying migration N of M…` to `Done` (or the recovery message on
// error).
//
// The events flow over the dedicated unprivileged channel
// `setup:migrationProgress` (Req 14.2, 14.9). We expose only the
// listener side here — the renderer cannot post to this channel — and
// return an unsubscribe callback so the React effect can clean up on
// unmount. Using a closure-scoped wrapper hides the raw
// `IpcRendererEvent` argument from renderer code; consumers see only
// the typed `MigrationProgressEvent`.

contextBridge.exposeInMainWorld('setupApi', {
  /**
   * Subscribe to migration progress events. Returns an unsubscribe
   * function so the renderer can detach the listener on unmount.
   */
  onMigrationProgress(
    handler: (event: MigrationProgressEvent) => void,
  ): () => void {
    const wrapped = (_e: IpcRendererEvent, payload: MigrationProgressEvent): void => {
      handler(payload);
    };
    ipcRenderer.on(MIGRATION_PROGRESS_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(MIGRATION_PROGRESS_CHANNEL, wrapped);
    };
  },
});
