/**
 * Bridge between the central `useApi()` toast handler and the
 * `<ToastProvider>` (task 13.4).
 *
 * `src/renderer/lib/api.ts` exposes a module-level `setToastHandler()`
 * hook that the `withToasts(api)` wrapper invokes for `INTERNAL` and
 * `UNAUTHENTICATED` envelopes. This component installs a handler that
 * routes every such envelope through `errorEnvelopeToToast` and into
 * the active `<ToastProvider>` queue — so the moment the app boots
 * with the provider mounted, the central `useApi()` surface starts
 * producing real on-screen toasts instead of console warnings.
 *
 * Implemented as a children-less effect-only component so it can sit
 * inside `<ToastProvider>` without contributing to the React tree's
 * shape. On unmount the bridge restores the default console handler
 * so test trees that mount and discard the bridge don't leak handlers
 * across files.
 *
 * Validates: Requirements 1.2, 3.7, 4.8, 4.9, 5.5.
 */

import { useEffect, type ReactElement } from 'react';

import { errorEnvelopeToToast, useToast } from '@renderer/components/ui';
import { resetToastHandler, setToastHandler } from '@renderer/lib/api';

export function ToastBridge(): ReactElement | null {
  const { showToast } = useToast();

  useEffect(() => {
    setToastHandler((envelope) => {
      const opts = errorEnvelopeToToast(envelope);
      showToast(opts);
    });
    return () => {
      resetToastHandler();
    };
  }, [showToast]);

  return null;
}
