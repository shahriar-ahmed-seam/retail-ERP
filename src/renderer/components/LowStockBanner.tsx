/**
 * Persistent low-stock banner (task 10.9, Phase 10).
 *
 * Subscribes to the `inventory:lowStockCount` channel and renders a
 * thin notification strip across the top of the layout whenever the
 * count is greater than zero. Hidden entirely when stock is healthy
 * so the banner does not consume vertical space in the resting state.
 *
 * Polling strategy:
 *
 *   - Primary path is a poll loop. The IPC layer does not yet support
 *     server-pushed events (no `onLowStockChange` channel — the V1
 *     IPC contract is request/response only), so the banner re-fetches
 *     the count on a configurable interval (default 30 seconds).
 *   - The poll continues across navigation because the banner is
 *     mounted at the shell level (Phase 13 task 13.6) and unmounts
 *     only when the renderer tears down.
 *   - In-flight requests are dropped via an epoch counter so a slow
 *     IPC roundtrip cannot overwrite a fresher response (same pattern
 *     as `usePaginatedList`).
 *
 * Click semantics:
 *
 *   - The banner is a `<button>` so keyboard users can activate it
 *     with Enter/Space and screen readers announce it correctly.
 *   - The click invokes the optional `onNavigate` prop. The route
 *     tree lands in Phase 13 (task 13.1); until then a parent passes
 *     a callback that drives whatever navigation surface it owns.
 *     Without a callback, the click is a no-op so the banner is safe
 *     to mount in standalone preview screens.
 *
 * Role gating: none. The banner is visible to every authenticated
 * role (Admin and Cashier per the current matrix) since
 * `inventory:lowStockCount` is allowed for both. Unauthenticated
 * renderers get an `Err('UNAUTHENTICATED')` envelope from the IPC
 * call; the banner stays hidden until the user signs in.
 *
 * Validates: Requirements 3.6, 9.3.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import { useApi } from '@renderer/lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default poll interval in milliseconds. Overridable for tests. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface LowStockBannerProps {
  /**
   * Click-through callback. Called when the banner is activated by
   * mouse or keyboard. Until the route tree lands in task 13.1 the
   * parent owns navigation; passing `undefined` makes the banner a
   * no-op on click (still visible, still announces the count).
   */
  readonly onNavigate?: () => void;
  /** Override the poll interval (ms). Default 30 000. */
  readonly pollIntervalMs?: number;
  /**
   * Disable the poll entirely. Useful in tests or in screens that
   * intentionally drive the count externally. Default `false`.
   */
  readonly disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LowStockBanner({
  onNavigate,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  disabled = false,
}: LowStockBannerProps): ReactElement | null {
  const api = useApi();

  const [count, setCount] = useState<number>(0);

  // Epoch counter so a stale resolve cannot overwrite a fresher count.
  const epochRef = useRef<number>(0);

  // Cleanup flag — set on unmount so the timer chain stops scheduling.
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  const refresh = useCallback((): void => {
    epochRef.current += 1;
    const myEpoch = epochRef.current;
    void (async () => {
      const result = await api['inventory:lowStockCount']();
      if (!mountedRef.current) return;
      if (epochRef.current !== myEpoch) return;
      if (!result.ok) {
        // Treat any error envelope as "hide the banner" — surfacing a
        // permission-denied or internal envelope at the top of every
        // screen would be more disruptive than the missing signal.
        setCount(0);
        return;
      }
      setCount(result.value.count);
    })();
  }, [api]);

  // Initial fetch + poll loop.
  useEffect(() => {
    if (disabled) return undefined;
    refresh();
    const handle = setInterval(() => {
      refresh();
    }, pollIntervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [disabled, pollIntervalMs, refresh]);

  if (count <= 0) return null;

  const label = `${count} product${count === 1 ? '' : 's'} below reorder level`;

  return (
    <div role="region" aria-label="Low stock alert">
      <button
        type="button"
        data-testid="low-stock-banner"
        data-low-stock-count={count}
        onClick={() => {
          onNavigate?.();
        }}
        style={{
          display: 'block',
          width: '100%',
          padding: '0.625rem 1rem',
          background: '#fff4e5',
          color: '#7a4a00',
          border: 'none',
          borderBottom: '1px solid #f0c989',
          cursor: onNavigate !== undefined ? 'pointer' : 'default',
          textAlign: 'left',
          fontFamily: 'system-ui, sans-serif',
          fontSize: '0.875rem',
        }}
      >
        <strong style={{ marginRight: '0.5rem' }}>Low stock:</strong>
        <span data-testid="low-stock-banner-label">{label}</span>
        {onNavigate !== undefined ? (
          <span
            aria-hidden="true"
            style={{ float: 'right', color: '#a76b1a' }}
          >
            View report →
          </span>
        ) : null}
      </button>
    </div>
  );
}
