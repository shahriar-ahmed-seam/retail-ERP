/**
 * Login screen (task 3.3, Requirements 1.1, 1.2, 1.5).
 *
 * Single-purpose form page used when no session is active. Submits username
 * + password to `auth:login` via the renderer auth context (`useAuth()`),
 * which handles the IPC + session caching. Render contract:
 *
 *   - Username text input, required, autoFocus.
 *   - Password input, type=password, required.
 *   - Submit button, disabled when username or password is empty or while
 *     the auth context is loading.
 *   - Error region below the form, populated from the most recent failed
 *     `Result` envelope. We surface both `error.message` and `error.code`
 *     so a Cashier can quote the code in a support call without leaking
 *     handler internals.
 *
 * After a successful login this page does not navigate by itself: there
 * is no router yet (task 13.1). Instead, the parent (`<App />` in
 * `src/renderer/index.tsx`) re-renders against `useAuth()` and switches
 * away from the login page once `session !== null`.
 *
 * Role-aware routing intent (filed for task 13.1):
 *   - Cashier         → `/pos`
 *   - Admin           → `/admin/dashboard`
 * These routes do not exist yet and the comments below mark the call
 * sites task 13.1 will replace.
 *
 * Validates: Requirements 1.1, 1.2, 1.5.
 */

import { useCallback, useState, type FormEvent, type ReactElement } from 'react';

import { useAuth } from '@renderer/lib/auth-context';

import type { ErrorEnvelope } from '@shared/result';

/**
 * Standalone login screen. No props — the page reads everything from the
 * auth context and owns its own form state.
 */
export function LoginPage(): ReactElement {
  const { login, isLoading } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ErrorEnvelope | null>(null);

  // Empty fields disable submit AND surface a hint via the form's
  // built-in `required` validation if the user tries to submit anyway.
  const trimmedUsername = username.trim();
  const canSubmit =
    trimmedUsername.length > 0 && password.length > 0 && !isLoading;

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!canSubmit) {
        return;
      }

      // Reset prior error before issuing a fresh attempt so a transient
      // failure (e.g. a typo) doesn't keep showing after a retry.
      setError(null);

      void (async () => {
        const result = await login(trimmedUsername, password);
        if (result.ok) {
          // Successful login; the auth context updates and the parent
          // <App /> swaps the login page out for the role-appropriate
          // home. TODO(task 13.1): once the router lands, replace the
          // <App /> branch with a `navigate(roleHomeFor(role))` call so
          // Cashiers go to `/pos` and Admins go to `/admin/dashboard`.
          return;
        }

        setError(result.error);
        // Keep the username field on screen but clear the password so a
        // shoulder surfer can't read it after a failed attempt.
        setPassword('');
      })();
    },
    [canSubmit, login, trimmedUsername, password],
  );

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: '24rem',
        margin: '4rem auto',
        padding: '2rem',
      }}
    >
      <h1 style={{ marginBottom: '1.5rem' }}>Sign in</h1>
      <form onSubmit={handleSubmit} noValidate={false}>
        <label
          htmlFor="login-username"
          style={{ display: 'block', marginBottom: '0.25rem' }}
        >
          Username
        </label>
        <input
          id="login-username"
          name="username"
          type="text"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
          style={{
            width: '100%',
            padding: '0.5rem',
            marginBottom: '1rem',
            boxSizing: 'border-box',
          }}
        />

        <label
          htmlFor="login-password"
          style={{ display: 'block', marginBottom: '0.25rem' }}
        >
          Password
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          style={{
            width: '100%',
            padding: '0.5rem',
            marginBottom: '1.25rem',
            boxSizing: 'border-box',
          }}
        />

        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            width: '100%',
            padding: '0.625rem',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {isLoading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {error !== null ? (
        <div
          role="alert"
          aria-live="polite"
          style={{
            marginTop: '1rem',
            padding: '0.75rem',
            border: '1px solid #c33',
            color: '#c33',
            background: '#fff5f5',
            borderRadius: 4,
          }}
        >
          <strong>{error.code}</strong>
          <div>{error.message}</div>
        </div>
      ) : null}
    </main>
  );
}
