/**
 * Renderer application root (task 13.1).
 *
 * Owns the three top-level concerns the role-aware shell composes:
 *
 *   1. The first-run setup probe. Before mounting anything else the
 *      renderer asks `setup:isRequired`. While the probe is in flight
 *      a neutral splash renders so login / setup never flashes
 *      momentarily on a fresh installation.
 *
 *   2. The setup branch. When `setup:isRequired === true` we render
 *      `<SetupPage />` outside the router — first-run setup is the
 *      only navigable surface, and once the admin account is created
 *      the auth context updates and `<App />` re-renders into the
 *      normal route tree.
 *
 *   3. The route tree itself. Wrapped in `<MemoryRouter>` for the
 *      Electron renderer so we never depend on `window.history` or a
 *      `file://` base URL — Electron's renderer loads via
 *      `loadFile()` (or `loadURL` for the dev server), and a hash /
 *      browser router would have to round-trip through the URL bar
 *      either way. Memory routing keeps the surface in-memory and
 *      survives reloads via Electron's native window state.
 *
 * `<App />` is mounted once by `src/renderer/index.tsx` (task 0.5)
 * inside an `<AuthProvider>`, so every route below can use
 * `useAuth()` to read the active session.
 *
 * Validates: Requirements 1.5, 1.6, 8.3, 14.2, 14.3.
 */

import {
  useEffect,
  useState,
  type ReactElement,
} from 'react';
import { MemoryRouter } from 'react-router-dom';

import { ToastBridge } from '@renderer/components/ToastBridge';
import { ToastProvider } from '@renderer/components/ui';
import { SetupPage } from '@renderer/features/setup';
import { useApi } from '@renderer/lib/api';
import { useAuth } from '@renderer/lib/auth-context';

import { AppRoutes } from './routes';

/**
 * Splash placeholder rendered while the first-run probe is in flight.
 * Stays minimal so a user on a fresh install does not see login
 * before the setup gate has a chance to run.
 */
function SetupProbeSplash(): ReactElement {
  return (
    <main
      data-testid="setup-probe-splash"
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        textAlign: 'center',
        color: '#555',
      }}
    >
      Loading…
    </main>
  );
}

export function App(): ReactElement {
  const api = useApi();
  const { session } = useAuth();

  // `null` while the probe is in flight, `boolean` once it resolved.
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [setupProbeError, setSetupProbeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api['setup:isRequired']();
      if (cancelled) return;
      if (result.ok) {
        setSetupRequired(result.value.required);
        setSetupProbeError(null);
      } else {
        // Probe is the very first IPC call on launch. If it fails we
        // assume the safer default of "no setup required" so the user
        // sees the login screen rather than being stuck on a spinner;
        // a real connectivity issue will surface there too.
        setSetupRequired(false);
        setSetupProbeError(`${result.error.code}: ${result.error.message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Re-probe the setup gate once a session disappears (logout) so a
  // freshly-wiped DB on the next launch behaves correctly. The session
  // dependency is intentional — the probe is cheap (a single SELECT
  // COUNT against `users`) and an extra call after logout has no
  // meaningful cost.
  useEffect(() => {
    if (session !== null) return undefined;
    let cancelled = false;
    void (async () => {
      const result = await api['setup:isRequired']();
      if (cancelled) return;
      if (result.ok) {
        setSetupRequired(result.value.required);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, session]);

  if (setupRequired === null) {
    return (
      <ToastProvider>
        <ToastBridge />
        <SetupProbeSplash />
      </ToastProvider>
    );
  }

  // Setup branch. Renders outside the router so first-run setup is
  // the only reachable surface — once `setupRequired` flips to false
  // (after `setup:createInitialAdmin` succeeds), the auth context
  // also has the new admin's session, so the next render hits the
  // route tree's authenticated subtree directly.
  if (setupRequired) {
    return (
      <ToastProvider>
        <ToastBridge />
        <SetupPage />
        {setupProbeError !== null ? (
          <div
            role="status"
            style={{
              maxWidth: '24rem',
              margin: '0 auto 2rem',
              padding: '0.75rem',
              color: '#a66',
              fontSize: '0.875rem',
              textAlign: 'center',
            }}
          >
            Setup probe failed: {setupProbeError}
          </div>
        ) : null}
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <ToastBridge />
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>
    </ToastProvider>
  );
}
