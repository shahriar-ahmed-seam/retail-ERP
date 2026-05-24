import { StrictMode, useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { LoginPage } from '@renderer/features/login';
import { SetupPage } from '@renderer/features/setup';
import { useApi } from '@renderer/lib/api';
import { AuthProvider, useAuth } from '@renderer/lib/auth-context';

/**
 * Renderer entry point.
 *
 * Wraps the application in <AuthProvider> (task 3.3) so the login screen
 * and any future page can read `useAuth()` to obtain the active session.
 *
 * On every launch the app first asks the main process whether first-run
 * setup is required (`setup:isRequired`, task 3.4). The result drives
 * which root page renders:
 *
 *   - `required: true`  → <SetupPage />     (Req 1.6, 14.2)
 *   - `required: false` + no session → <LoginPage />
 *   - `required: false` + session    → role-aware home (placeholder until
 *                                       task 13.1 brings the router)
 *
 * While the probe is in flight a small loading shim renders so the
 * login screen doesn't briefly flash on a fresh install.
 *
 * The route tree itself lands in task 13.1; until then the authenticated
 * branch shows a placeholder "logged in as …" panel that confirms the
 * auth context is wired correctly.
 */
function App(): ReactElement {
  const api = useApi();
  const { session, logout, isLoading } = useAuth();

  // `null` while the probe is in flight, `boolean` once it has resolved.
  // We deliberately do not assume `false` on first render — the login
  // page would briefly flash on a fresh install otherwise.
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
        // The probe is the very first IPC call on launch. If it fails we
        // assume the safer default of "no setup required" so the user
        // sees the login screen rather than being stuck on a spinner —
        // a real connectivity issue will surface there too.
        setSetupRequired(false);
        setSetupProbeError(`${result.error.code}: ${result.error.message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (setupRequired === null) {
    // Probe in flight. A neutral splash so we never render login or
    // setup before we know which one is correct.
    return (
      <main
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

  if (setupRequired) {
    return <SetupPage />;
  }

  if (session === null) {
    return (
      <>
        <LoginPage />
        {setupProbeError !== null ? (
          // Surface a non-blocking note if the first-run probe itself
          // failed. Users can still log in (the login channel has its
          // own envelope-level error reporting), but a sysadmin reading
          // the screen will spot the underlying issue.
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
      </>
    );
  }

  // TODO(task 13.1): replace with a real router. Cashier → /pos,
  // Admin → /admin/dashboard. For now this confirms the auth context is
  // wired correctly.
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>Core Retail ERP</h1>
      <p>
        Logged in as <strong>{session.username}</strong> ({session.role})
      </p>
      <button
        type="button"
        onClick={() => {
          void logout();
        }}
        disabled={isLoading}
      >
        {isLoading ? 'Signing out…' : 'Sign out'}
      </button>
    </main>
  );
}

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
