/**
 * Initial Admin Setup screen (task 3.4, Requirements 1.6, 14.2).
 *
 * Reachable only on first run, when the renderer has just received
 * `{ required: true }` from `setup:isRequired`. The parent (`<App />`
 * in `src/renderer/index.tsx`) gates this — once an admin exists the
 * channel returns `{ required: false }` and the user is routed to the
 * login screen instead.
 *
 * Render contract:
 *   - Username text input, required, autoFocus.
 *   - Password input (`type=password`), required.
 *   - Confirm-password input (`type=password`), required.
 *   - Submit button. Disabled when:
 *       * any field is empty, OR
 *       * `password !== confirmPassword`, OR
 *       * the auth context is mid-call.
 *   - Inline mismatch hint shown beneath the confirm field as soon as
 *     the user has typed anything in either password field and the
 *     two values differ. The hint disappears the moment the values
 *     match, so a typo on the last keystroke clears as soon as it is
 *     fixed.
 *   - Server-error region populated from the most recent failed
 *     `Result` envelope. Surfaces both `error.code` and `error.message`
 *     so the most common first-run failure (the rare
 *     `FORBIDDEN { reason: admin_already_exists }` race when the gate
 *     was passed but a parallel renderer beat us to it) is legible.
 *
 * After a successful submission this page does not navigate by itself:
 * `useAuth().createInitialAdmin` stores the freshly-issued `SessionDTO`
 * in the auth context, which causes `<App />` to re-render against the
 * authenticated branch. Same pattern as `<LoginPage />`.
 *
 * Validates: Requirements 1.6, 14.2.
 */

import { useCallback, useState, type FormEvent, type ReactElement } from 'react';

import { useAuth } from '@renderer/lib/auth-context';

import type { ErrorEnvelope } from '@shared/result';

/**
 * Standalone setup screen. No props — the page reads everything from
 * the auth context and owns its own form state.
 */
export function SetupPage(): ReactElement {
  const { createInitialAdmin, isLoading } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<ErrorEnvelope | null>(null);

  const trimmedUsername = username.trim();
  const passwordsMatch = password === confirmPassword;
  // The mismatch hint only fires once the user has typed something in
  // at least one password field AND the values differ. This avoids
  // shouting "passwords do not match" at an empty form on first paint.
  const showMismatchHint =
    !passwordsMatch && (password.length > 0 || confirmPassword.length > 0);

  const canSubmit =
    trimmedUsername.length > 0 &&
    password.length > 0 &&
    confirmPassword.length > 0 &&
    passwordsMatch &&
    !isLoading;

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!canSubmit) {
        return;
      }

      // Reset prior server error before issuing a fresh attempt so a
      // transient failure (e.g. a typo) doesn't keep showing after a
      // retry.
      setError(null);

      void (async () => {
        const result = await createInitialAdmin(trimmedUsername, password);
        if (result.ok) {
          // Success: the auth context has the new admin's session and
          // the parent <App /> swaps to the authenticated tree.
          return;
        }

        setError(result.error);
        // Clear both password fields after a failed attempt so the user
        // re-enters them deliberately. Username is preserved.
        setPassword('');
        setConfirmPassword('');
      })();
    },
    [canSubmit, createInitialAdmin, trimmedUsername, password],
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
      <h1 style={{ marginBottom: '0.5rem' }}>Welcome</h1>
      <p style={{ marginBottom: '1.5rem', color: '#555' }}>
        Create the initial administrator account to start using Core Retail
        ERP.
      </p>

      <form onSubmit={handleSubmit} noValidate={false}>
        <label
          htmlFor="setup-username"
          style={{ display: 'block', marginBottom: '0.25rem' }}
        >
          Username
        </label>
        <input
          id="setup-username"
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
          htmlFor="setup-password"
          style={{ display: 'block', marginBottom: '0.25rem' }}
        >
          Password
        </label>
        <input
          id="setup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          style={{
            width: '100%',
            padding: '0.5rem',
            marginBottom: '1rem',
            boxSizing: 'border-box',
          }}
        />

        <label
          htmlFor="setup-confirm-password"
          style={{ display: 'block', marginBottom: '0.25rem' }}
        >
          Confirm password
        </label>
        <input
          id="setup-confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={showMismatchHint}
          aria-describedby={
            showMismatchHint ? 'setup-confirm-password-hint' : undefined
          }
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
          }}
          style={{
            width: '100%',
            padding: '0.5rem',
            marginBottom: showMismatchHint ? '0.25rem' : '1.25rem',
            boxSizing: 'border-box',
          }}
        />

        {showMismatchHint ? (
          <div
            id="setup-confirm-password-hint"
            role="status"
            style={{
              marginBottom: '1.25rem',
              color: '#c33',
              fontSize: '0.875rem',
            }}
          >
            Passwords do not match.
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            width: '100%',
            padding: '0.625rem',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {isLoading ? 'Creating account…' : 'Create admin account'}
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
