/**
 * Renderer-side authentication context (task 3.3).
 *
 * The main process is the only authority on session lifecycle: `auth:login`
 * creates and returns a `SessionDTO`, `auth:logout` clears it, and the
 * session itself lives in `src/main/auth/session-store.ts` keyed by the
 * renderer's sender id (Phase 2 task 2.5). Per design.md > "Session
 * lifecycle", sessions die with the renderer window — this context
 * therefore keeps the `SessionDTO` in memory only. There is no
 * `localStorage`, `sessionStorage`, cookie, or `app.userData` persistence
 * on the renderer side; reload + re-login is the intended flow.
 *
 * Surface:
 *   - `AuthProvider`  — wraps the renderer tree, owns the React state.
 *   - `useAuth()`     — returns `{ session, isLoading, login, logout }`.
 *
 * `login(username, password)` calls `api['auth:login']` through the toasted
 * `useApi()` wrapper so any `INTERNAL` / `UNAUTHENTICATED` envelopes from
 * the wrapper layer surface as toasts; the raw `Result` is still returned
 * to the caller so the login form can render inline `VALIDATION` errors
 * (Req 1.2). On a successful login the session is stored in context and
 * any consumer rendering against `useAuth()` re-renders.
 *
 * `logout()` calls `api['auth:logout']`, then clears the session
 * regardless of the IPC result — a renderer that is already detached
 * from its main-process session must still drop its local cache so the
 * UI snaps back to the login screen.
 *
 * Validates: Requirements 1.1, 1.2, 1.5.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useApi } from './api.js';

import type { SessionDTO } from '@shared/ipc-contract';
import type { Result } from '@shared/result';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** State half of the auth context (read-side). */
export interface AuthState {
  /** Active session, or `null` when no user is logged in. */
  readonly session: SessionDTO | null;
  /** True while a `login` or `logout` call is in flight. */
  readonly isLoading: boolean;
}

/** Full auth context shape returned by `useAuth()`. */
export interface AuthContextValue extends AuthState {
  /**
   * Submit credentials to `auth:login`. Returns the same `Result` envelope
   * as the underlying IPC call so the caller can render code-specific UI
   * (e.g. inline `VALIDATION` errors on the login form). On success the
   * `SessionDTO` is also stored in context and propagated to consumers.
   */
  readonly login: (
    username: string,
    password: string,
  ) => Promise<Result<SessionDTO>>;
  /**
   * Submit credentials to `setup:createInitialAdmin` (Req 1.6, task 3.4).
   * Reachable only on first launch (when `setup:isRequired` returns
   * `{ required: true }`). Behaviour mirrors `login`: returns the raw
   * `Result` so the caller can render `VALIDATION` / `FORBIDDEN` envelopes
   * inline, and on success stores the `SessionDTO` in context so the app
   * routes straight into the home screen without a second round-trip
   * through the login form.
   */
  readonly createInitialAdmin: (
    username: string,
    password: string,
  ) => Promise<Result<SessionDTO>>;
  /**
   * Submit `auth:logout` and clear the local session. The renderer's local
   * cache is cleared even if the IPC call fails so the UI cannot get
   * stuck in a "still logged in" state when the main-process session is
   * already gone (e.g. after an `app.before-quit`-driven `clearAll`).
   */
  readonly logout: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Context default. The value is intentionally the "no provider mounted"
 * sentinel — `useAuth()` throws when it sees this so a misuse (rendering a
 * consumer outside the provider) fails loudly instead of silently
 * pretending no one is logged in.
 */
const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AuthProviderProps {
  readonly children: ReactNode;
  /**
   * Optional initial session — used in tests to bootstrap a logged-in
   * tree without going through the IPC mock.
   */
  readonly initialSession?: SessionDTO | null;
}

/**
 * React provider that owns the auth state. Wraps the application tree at
 * the renderer entry (`src/renderer/index.tsx`) so every feature page can
 * read `useAuth()` to discover the active role and, when needed, invoke
 * `login` / `logout`.
 */
export function AuthProvider({
  children,
  initialSession = null,
}: AuthProviderProps): ReactElement {
  const api = useApi();
  const [session, setSession] = useState<SessionDTO | null>(initialSession);
  const [isLoading, setIsLoading] = useState(false);

  const login = useCallback(
    async (username: string, password: string): Promise<Result<SessionDTO>> => {
      setIsLoading(true);
      try {
        const result = await api['auth:login']({ username, password });
        if (result.ok) {
          setSession(result.value);
        }
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [api],
  );

  const createInitialAdmin = useCallback(
    async (username: string, password: string): Promise<Result<SessionDTO>> => {
      setIsLoading(true);
      try {
        const result = await api['setup:createInitialAdmin']({ username, password });
        if (result.ok) {
          setSession(result.value);
        }
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [api],
  );

  const logout = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      // Always attempt the IPC call, but never block local cleanup on its
      // outcome — see the docstring above.
      await api['auth:logout']();
    } finally {
      setSession(null);
      setIsLoading(false);
    }
  }, [api]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, isLoading, login, createInitialAdmin, logout }),
    [session, isLoading, login, createInitialAdmin, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Read the auth context. Throws if called outside an `AuthProvider` — that
 * is always a programmer error in this app, not a runtime branch worth
 * handling (the entry wraps the entire tree in `AuthProvider`).
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth() called outside of <AuthProvider>.');
  }
  return ctx;
}
