/**
 * Renderer-side typed wrapper over `window.api` (task 2.7).
 *
 * The preload script (task 2.6) exposes one method per `IpcContract` channel
 * on `window.api`, each returning `Promise<Result<TRes>>`. This module
 * provides the renderer's view of that surface:
 *
 *   - `api`      — a proxy that delegates each `api.<channel>(req)` call to
 *                  `window.api[channel](req)` with a runtime guard for the
 *                  "running outside Electron" case (e.g. unit tests, SSR).
 *   - `useApi()` — a thin hook that returns the same typed surface but with
 *                  each call wrapped to surface toasts for `INTERNAL` and
 *                  `UNAUTHENTICATED` error envelopes. Components still
 *                  receive the raw `Result<T>` so they can pattern-match on
 *                  specific error codes (e.g. inline `VALIDATION` errors).
 *   - `setToastHandler` / `resetToastHandler` — integration points for the
 *                  toast UX system landing in task 13.4. Until then the
 *                  default handler logs the envelope to the console so the
 *                  errors are visible during development.
 *
 * The `Window['api']` global is declared at the bottom of this module so the
 * renderer typechecks even before the preload bundle is loaded — the runtime
 * guard in `getNativeApi` handles the "preload missing" failure mode.
 *
 * Validates: Requirements 1.5.
 */

import { useMemo } from 'react';

import type {
  IpcChannel,
  IpcRequest,
  IpcResponse,
} from '@shared/ipc-contract';
import type { ErrorCode, ErrorEnvelope, Result } from '@shared/result';

// ---------------------------------------------------------------------------
// Typed surface
// ---------------------------------------------------------------------------

/**
 * Per-channel call signature. Channels whose request is `void` accept a
 * zero-argument call (`api['auth:logout']()`); all others require the typed
 * request payload.
 */
export type ApiMethod<C extends IpcChannel> = IpcRequest<C> extends void
  ? () => Promise<Result<IpcResponse<C>>>
  : (req: IpcRequest<C>) => Promise<Result<IpcResponse<C>>>;

/**
 * Full typed renderer surface — exactly one method per `IpcContract` key.
 * Identical on both sides of the bridge: the preload script constructs the
 * same shape from the channel list, and the renderer consumes it here.
 */
export type Api = { readonly [C in IpcChannel]: ApiMethod<C> };

// ---------------------------------------------------------------------------
// Runtime accessor
// ---------------------------------------------------------------------------

/** Discriminator used when the bridge is missing entirely. */
const PRELOAD_MISSING_MESSAGE =
  "renderer api: 'window.api' is not exposed — preload script did not run.";

/** Discriminator used when there is no `window` at all (Node, SSR). */
const WINDOW_MISSING_MESSAGE =
  "renderer api: 'window' is not defined — running outside an Electron renderer?";

/**
 * Resolve the native `window.api` once per call so unit tests can stub it
 * after this module loads. Throws synchronously if the bridge is missing —
 * the proxy below catches that and converts it into a rejected `Promise` so
 * call sites still see a normal async failure.
 */
function getNativeApi(): Api {
  if (typeof window === 'undefined') {
    throw new Error(WINDOW_MISSING_MESSAGE);
  }
  const candidate = (window as Window & { api?: Api }).api;
  if (candidate === undefined || candidate === null) {
    throw new Error(PRELOAD_MISSING_MESSAGE);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// `api` proxy
// ---------------------------------------------------------------------------

/**
 * Typed delegate to `window.api`. Channel names are looked up dynamically so
 * the renderer never needs to enumerate `IpcContract` here — adding a channel
 * to the contract automatically extends `Api` and is callable through this
 * proxy without code changes.
 */
const apiTarget = {} as Api;

export const api: Api = new Proxy(apiTarget, {
  get(_target, prop: string | symbol): unknown {
    if (typeof prop !== 'string') {
      return undefined;
    }
    return (req: unknown): Promise<Result<unknown>> => {
      let native: Api;
      try {
        native = getNativeApi();
      } catch (error) {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'INTERNAL',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
      const channel = prop as IpcChannel;
      const fn = (native as Record<string, unknown>)[channel];
      if (typeof fn !== 'function') {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'INTERNAL',
            message: `renderer api: unknown IPC channel '${channel}'.`,
          },
        });
      }
      return (fn as (r: unknown) => Promise<Result<unknown>>).call(native, req);
    };
  },
});

// ---------------------------------------------------------------------------
// Toast integration
// ---------------------------------------------------------------------------

/**
 * Receiver for error envelopes that should surface a toast. Task 13.4 will
 * replace the default with a UI-bound implementation (the central error
 * mapper called out in design.md > "Error handling > Renderer surfaces").
 */
export type ToastHandler = (error: ErrorEnvelope) => void;

/**
 * Default handler used until task 13.4 wires the real toast system. Logs to
 * the console so unhandled errors are still visible during development; uses
 * `console.warn` rather than `error` to avoid tripping test runners that
 * promote `console.error` to a failure.
 */
const defaultToastHandler: ToastHandler = (error) => {
  console.warn(`[api] ${error.code}: ${error.message}`, error);
};

let activeToastHandler: ToastHandler = defaultToastHandler;

/**
 * Replace the global toast handler. Intended for task 13.4 (wiring the real
 * toast UX) and for tests that need to assert on toast-surfaced errors.
 */
export function setToastHandler(handler: ToastHandler): void {
  activeToastHandler = handler;
}

/** Restore the default console-logging handler. */
export function resetToastHandler(): void {
  activeToastHandler = defaultToastHandler;
}

/**
 * Error codes that the hook layer surfaces as toasts. `INTERNAL` is the
 * catch-all for unexpected handler failures (and is always logged with an
 * `errorId` so the user can quote it in a support ticket); `UNAUTHENTICATED`
 * means the session has expired and the user must be redirected to login —
 * both warrant a toast at the call site rather than inline UI.
 *
 * `FORBIDDEN`, `VALIDATION`, `OUT_OF_STOCK`, etc. are deliberately excluded:
 * those carry per-field or per-line context that components render inline.
 */
const TOASTABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'INTERNAL',
  'UNAUTHENTICATED',
]);

/** Visible-for-testing helper that checks whether a code triggers a toast. */
export function shouldToast(code: ErrorCode): boolean {
  return TOASTABLE_CODES.has(code);
}

/**
 * Wrap a typed `Api` so each call invokes the active toast handler when the
 * settled `Result` carries a toastable error envelope. The result itself is
 * returned unmodified; toasting is a side effect.
 */
export function withToasts(target: Api): Api {
  return new Proxy(target, {
    get(t, prop: string | symbol): unknown {
      if (typeof prop !== 'string') {
        return undefined;
      }
      const inner = (t as Record<string, unknown>)[prop];
      if (typeof inner !== 'function') {
        return inner;
      }
      return async (req: unknown): Promise<Result<unknown>> => {
        const result = await (inner as (r: unknown) => Promise<Result<unknown>>).call(t, req);
        if (!result.ok && TOASTABLE_CODES.has(result.error.code)) {
          try {
            activeToastHandler(result.error);
          } catch {
            // A misbehaving toast handler must never break the IPC contract.
          }
        }
        return result;
      };
    },
  });
}

/**
 * Singleton toasted view over `api`. Stable across the application lifetime
 * so `useApi()` can return a referentially equal value on every render —
 * components depending on it via `useEffect`/`useMemo` won't re-fire.
 */
const toastedApi: Api = withToasts(api);

/**
 * Hook layer over the typed `api` proxy. Returns the same surface but with
 * `INTERNAL` and `UNAUTHENTICATED` error envelopes routed through the active
 * toast handler. Future expansions (suspense on pending, query-key
 * deduplication) live in task 13.4.
 *
 * Wrapped in `useMemo` with an empty dependency list so callers receive a
 * stable reference even though the underlying value is module-level — keeps
 * the call site idiomatic and ready for future per-component state.
 */
export function useApi(): Api {
  return useMemo(() => toastedApi, []);
}

// ---------------------------------------------------------------------------
// Global augmentation
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    readonly api: Api;
  }
}
