/**
 * Renderer-side helpers barrel.
 *
 * Re-exports the typed IPC wrapper (task 2.7) so feature pages can import a
 * single `@renderer/lib` entry point. New helpers (form utilities, toast
 * primitives, etc.) attach here as later phases land.
 */

export {
  api,
  resetToastHandler,
  setToastHandler,
  shouldToast,
  useApi,
  withToasts,
  type Api,
  type ApiMethod,
  type ToastHandler,
} from './api.js';

export {
  AuthProvider,
  useAuth,
  type AuthContextValue,
  type AuthProviderProps,
  type AuthState,
} from './auth-context.js';
