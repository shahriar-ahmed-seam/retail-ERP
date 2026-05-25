/**
 * Toast notification system (task 13.4).
 *
 * Three pieces compose this surface:
 *
 *   1. `<ToastProvider>` — owns the toast queue, mounts a top-right
 *      portal at `document.body`, and exposes `showToast` /
 *      `dismissToast` through React context. Toasts auto-dismiss after
 *      `DEFAULT_DURATION_MS` (4 seconds) but can be manually dismissed
 *      via the close button or the public `dismissToast(id)` API.
 *   2. `useToast()` — small hook that returns the context value. Throws
 *      when called outside the provider so a misuse fails loudly.
 *   3. `errorEnvelopeToToast(env)` — pure mapper from `ErrorEnvelope` to
 *      a friendly `ToastOptions` payload. Keyed off `ErrorEnvelope.code`
 *      per the design.md > "Error taxonomy" table; the renderer's
 *      central error mapper (used by `useApi()` via the bridge in
 *      `index.tsx`) hands every toastable envelope through this
 *      function.
 *
 * The provider supports four variants — `success`, `error`, `warning`,
 * `info` — each with its own colour, icon, and ARIA role
 * (`role="status"` for non-error variants, `role="alert"` for errors)
 * so screen readers surface them correctly.
 *
 * Validates: Requirements 1.2, 3.7, 4.8, 4.9, 5.5.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default visible time per toast, in milliseconds. */
const DEFAULT_DURATION_MS = 4000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Discriminator for the four toast variants. */
export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

/**
 * Caller-supplied options when raising a toast. `id` is optional — the
 * provider mints one when absent. `durationMs: 0` disables auto-dismiss
 * for that toast (useful for `INTERNAL` envelopes that carry an
 * `errorId` users may need to copy).
 */
export interface ToastOptions {
  readonly id?: string;
  readonly variant: ToastVariant;
  readonly title: string;
  readonly description?: string;
  /**
   * Auto-dismiss delay in ms. Defaults to {@link DEFAULT_DURATION_MS}.
   * Pass `0` to disable auto-dismiss.
   */
  readonly durationMs?: number;
}

/** Active toast record held in the provider's queue. */
interface ToastRecord extends Required<Pick<ToastOptions, 'id' | 'variant' | 'title'>> {
  readonly description: string | null;
  readonly durationMs: number;
}

/** Public hook value. */
export interface ToastContextValue {
  /** Raise a toast. Returns the assigned id so the caller can dismiss it. */
  readonly showToast: (opts: ToastOptions) => string;
  /** Manually dismiss a toast by id. No-op if the toast already closed. */
  readonly dismissToast: (id: string) => void;
  /** Currently-visible toasts. Exposed for tests; renderer code should
   *  not rely on this. */
  readonly toasts: readonly ToastRecord[];
}

// ---------------------------------------------------------------------------
// Error envelope → toast mapper
// ---------------------------------------------------------------------------

/**
 * Map an `ErrorEnvelope` to a friendly `ToastOptions` payload.
 *
 * The mapping mirrors design.md > "Error taxonomy": each code gets a
 * variant (`error` for hard failures, `warning` for guardrail
 * envelopes such as `OUT_OF_STOCK` that the cashier can resolve, and
 * `info` for `USER_CANCELED`) and a friendly title/description that
 * the renderer can show without the user ever seeing the raw code.
 *
 * `INTERNAL` carries an `errorId` correlation handle when present so a
 * support ticket can quote it; the description is rendered with the id
 * appended (`Error id: …`). The default duration is left at 4 s for
 * every variant; callers needing a sticky error surface (e.g. the
 * recovery prompt in Phase 11) can override `durationMs` after this
 * mapper.
 */
export function errorEnvelopeToToast(env: ErrorEnvelope): ToastOptions {
  switch (env.code) {
    case 'VALIDATION':
      return {
        variant: 'error',
        title: 'Invalid input',
        description: env.message,
      };
    case 'OUT_OF_STOCK':
      return {
        variant: 'warning',
        title: 'Out of stock',
        description: env.message,
      };
    case 'UNIQUE_VIOLATION':
      return {
        variant: 'error',
        title: 'Duplicate value',
        description: env.message,
      };
    case 'FK_VIOLATION':
      return {
        variant: 'error',
        title: 'Reference not found',
        description: env.message,
      };
    case 'UNAUTHENTICATED':
      return {
        variant: 'error',
        title: 'Session expired',
        description: 'Please sign in again to continue.',
      };
    case 'FORBIDDEN':
      return {
        variant: 'error',
        title: 'Permission denied',
        description: env.message,
      };
    case 'USER_CANCELED':
      return {
        variant: 'info',
        title: 'Canceled',
        description: env.message,
      };
    case 'PRINTER_FAILURE':
      return {
        variant: 'warning',
        title: 'Printer unavailable',
        description: env.message,
      };
    case 'DB_INTEGRITY':
      return {
        variant: 'error',
        title: 'Database integrity error',
        description: env.message,
      };
    case 'INTERNAL': {
      const description =
        env.errorId !== undefined
          ? `${env.message} (Error id: ${env.errorId})`
          : env.message;
      return {
        variant: 'error',
        title: 'Something went wrong',
        description,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ToastProviderProps {
  readonly children: ReactNode;
  /**
   * Default auto-dismiss duration, in ms. Tests override to use a
   * shorter window. Defaults to {@link DEFAULT_DURATION_MS}.
   */
  readonly defaultDurationMs?: number;
}

export function ToastProvider({
  children,
  defaultDurationMs = DEFAULT_DURATION_MS,
}: ToastProviderProps): ReactElement {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);

  // Stable monotonic id source. Pulled out to a ref so the value
  // survives StrictMode's double-invocation of the render body.
  const idCounterRef = useRef<number>(0);

  // Auto-dismiss timers, keyed by toast id, so manual dismiss can
  // cancel them and the provider unmount can clear all of them.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const dismissToast = useCallback((id: string): void => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (opts: ToastOptions): string => {
      idCounterRef.current += 1;
      const id = opts.id ?? `toast-${String(idCounterRef.current)}`;
      const duration =
        opts.durationMs ?? defaultDurationMs;
      const record: ToastRecord = {
        id,
        variant: opts.variant,
        title: opts.title,
        description: opts.description ?? null,
        durationMs: duration,
      };
      setToasts((prev) => {
        // De-duplicate by id so an explicit caller-supplied id replaces
        // the previous instance instead of stacking duplicates.
        const filtered = prev.filter((t) => t.id !== id);
        return [...filtered, record];
      });
      // Cancel any previous timer associated with this id and start a
      // fresh one when auto-dismiss is enabled.
      const previousTimer = timersRef.current.get(id);
      if (previousTimer !== undefined) {
        clearTimeout(previousTimer);
        timersRef.current.delete(id);
      }
      if (duration > 0) {
        const handle = setTimeout(() => {
          timersRef.current.delete(id);
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
        timersRef.current.set(id, handle);
      }
      return id;
    },
    [defaultDurationMs],
  );

  // Cancel every pending timer when the provider unmounts.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) {
        clearTimeout(handle);
      }
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast, toasts }),
    [showToast, dismissToast, toasts],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast() called outside of <ToastProvider>.');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Viewport (top-right portal)
// ---------------------------------------------------------------------------

interface ToastViewportProps {
  readonly toasts: readonly ToastRecord[];
  readonly onDismiss: (id: string) => void;
}

function ToastViewport({
  toasts,
  onDismiss,
}: ToastViewportProps): ReactElement | null {
  // jsdom + SSR safety: only mount the portal when a real document is
  // available. The provider itself still hands out `showToast`/
  // `dismissToast`; the portal just doesn't render until the DOM is
  // ready.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      data-testid="toast-viewport"
      role="region"
      aria-label="Notifications"
      style={{
        position: 'fixed',
        top: '1rem',
        right: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        zIndex: 9999,
        pointerEvents: 'none',
        maxWidth: 'min(24rem, calc(100vw - 2rem))',
      }}
    >
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Single toast
// ---------------------------------------------------------------------------

interface ToastViewProps {
  readonly toast: ToastRecord;
  readonly onDismiss: (id: string) => void;
}

const VARIANT_STYLES: Readonly<Record<ToastVariant, {
  readonly background: string;
  readonly color: string;
  readonly border: string;
}>> = {
  success: {
    background: '#f3fff7',
    color: '#1a6',
    border: '#2a8',
  },
  error: {
    background: '#fff5f5',
    color: '#a33',
    border: '#c33',
  },
  warning: {
    background: '#fff8e6',
    color: '#7a4a00',
    border: '#d09a3a',
  },
  info: {
    background: '#f0f7ff',
    color: '#1e40af',
    border: '#5070c8',
  },
};

function ToastView({ toast, onDismiss }: ToastViewProps): ReactElement {
  const styles = VARIANT_STYLES[toast.variant];
  // `error` variant uses `role="alert"` so screen readers interrupt;
  // others use `role="status"` so they queue politely.
  const role = toast.variant === 'error' ? 'alert' : 'status';
  return (
    <div
      role={role}
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      data-testid={`toast-${toast.id}`}
      data-toast-variant={toast.variant}
      style={{
        pointerEvents: 'auto',
        background: styles.background,
        color: styles.color,
        border: `1px solid ${styles.border}`,
        borderRadius: 6,
        padding: '0.625rem 0.75rem',
        boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '0.875rem',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.5rem',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          data-testid={`toast-${toast.id}-title`}
          style={{ fontWeight: 600 }}
        >
          {toast.title}
        </div>
        {toast.description !== null ? (
          <div
            data-testid={`toast-${toast.id}-description`}
            style={{ marginTop: '0.125rem', color: styles.color, opacity: 0.9 }}
          >
            {toast.description}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        data-testid={`toast-${toast.id}-dismiss`}
        aria-label="Dismiss notification"
        onClick={() => {
          onDismiss(toast.id);
        }}
        style={{
          background: 'transparent',
          border: 'none',
          color: styles.color,
          cursor: 'pointer',
          padding: '0 0.25rem',
          fontSize: '1rem',
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}
