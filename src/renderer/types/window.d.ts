// src/renderer/types/window.d.ts
//
// Global declaration that augments `globalThis.Window` with the typed
// `api` surface exposed by the preload bridge (`src/preload/index.ts`,
// task 2.6).
//
// Lives under `src/renderer/types/` (not under `src/preload/`) so it is
// only visible to the renderer's tsconfig. The renderer is the only
// process that should see `window.api`; the main and preload processes
// have their own scopes and including this file there would mislead
// readers into thinking `window.api` is reachable from those scopes.
//
// The renderer's typed wrapper (`src/renderer/lib/api.ts`, task 2.7)
// reads `window.api` through this declaration; UI code typically goes
// through that wrapper rather than touching `window.api` directly so
// per-channel hooks (loading state, toast on `INTERNAL`, etc.) stay
// centralised.
//
// Validates: Requirement 1.5.

import type { Api } from '@shared/ipc-contract';

declare global {
  interface Window {
    /**
     * Typed bridge exposed by the preload script via
     * `contextBridge.exposeInMainWorld('api', ...)`. One async method per
     * IPC channel; each returns a `Result<IpcResponse<C>>` envelope.
     */
    readonly api: Api;
  }
}

// Module-style declaration files must export something to be picked up
// as modules by `tsc`. The empty export is the canonical idiom.
export {};
