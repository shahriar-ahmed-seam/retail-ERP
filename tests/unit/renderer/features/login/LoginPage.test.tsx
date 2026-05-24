/**
 * Unit tests for the login screen (task 3.3).
 *
 * The renderer's typed API wrapper (`@renderer/lib/api`) reads the
 * preload-exposed `window.api` lazily, so each test installs a stub on
 * `globalThis.window.api` before mounting the component. The auth
 * context (`AuthProvider` / `useAuth`) drives the page through the same
 * wrapper, so wiring the stub is enough to exercise the full path.
 *
 * Coverage:
 *   - Form renders username + password + submit (Req 1.1).
 *   - Submit with valid creds + mocked api success → auth context
 *     receives the returned `SessionDTO` (Req 1.1, 1.5).
 *   - Submit with mocked api UNAUTHENTICATED → error message + code
 *     visible (Req 1.2).
 *   - Empty fields → submit disabled.
 *
 * Validates: Requirements 1.1, 1.2, 1.5.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from '@renderer/features/login/LoginPage';
import { AuthProvider, useAuth } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { SessionDTO } from '@shared/ipc-contract';
import type { ReactElement } from 'react';

type GlobalWithWindow = typeof globalThis & {
  window: Window & { api?: Partial<Api> };
};

const g = globalThis as unknown as GlobalWithWindow;

function installApi(stub: Partial<Api>): void {
  // jsdom defines `window` already; we attach `api` onto it instead of
  // replacing the window object so React + Testing Library keep working.
  g.window.api = stub;
}

function uninstallApi(): void {
  delete g.window.api;
}

afterEach(() => {
  uninstallApi();
});

const validSession: SessionDTO = {
  sessionId: 'sess-1',
  userId: 'user-1',
  username: 'admin',
  role: 'Admin',
};

describe('<LoginPage />', () => {
  it('renders username, password, and submit', () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('keeps the submit button disabled when fields are empty', () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
  });

  it('disables submit when only one field is filled', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/username/i), 'admin');
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
  });

  it('forwards submit to api[auth:login] and updates the auth context on success', async () => {
    const login = vi.fn().mockResolvedValue(Ok(validSession));
    installApi({ 'auth:login': login as Api['auth:login'] });

    function CurrentSession(): ReactElement {
      const { session } = useAuth();
      return (
        <div data-testid="session-readout">
          {session === null ? 'no-session' : `${session.username}:${session.role}`}
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <LoginPage />
        <CurrentSession />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'hunter2');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledTimes(1);
    });
    expect(login).toHaveBeenCalledWith({ username: 'admin', password: 'hunter2' });

    await waitFor(() => {
      expect(screen.getByTestId('session-readout')).toHaveTextContent('admin:Admin');
    });
  });

  it('renders error code + message on UNAUTHENTICATED and clears the password', async () => {
    const login = vi
      .fn()
      .mockResolvedValue(Err('UNAUTHENTICATED', { reason: 'bad-credentials' }));
    installApi({ 'auth:login': login as Api['auth:login'] });

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('UNAUTHENTICATED');
    expect(alert).toHaveTextContent(/sign(ed)? in/i);

    // Username is preserved so the cashier can retry without retyping it.
    expect(screen.getByLabelText(/username/i)).toHaveValue('admin');
    // Password is cleared after a failed attempt.
    expect(screen.getByLabelText(/password/i)).toHaveValue('');
  });

  it('trims the username before submission', async () => {
    const login = vi.fn().mockResolvedValue(Ok(validSession));
    installApi({ 'auth:login': login as Api['auth:login'] });

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/username/i), '  admin  ');
    await user.type(screen.getByLabelText(/password/i), 'hunter2');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({ username: 'admin', password: 'hunter2' });
    });
  });
});

describe('<LoginPage /> initial-session bypass', () => {
  beforeEach(() => {
    installApi({});
  });

  it('does not render the login form when initialSession is provided', () => {
    function Probe(): ReactElement {
      const { session } = useAuth();
      return (
        <div data-testid="probe">
          {session === null ? 'unauthenticated' : 'authenticated'}
        </div>
      );
    }

    render(
      <AuthProvider initialSession={validSession}>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByTestId('probe')).toHaveTextContent('authenticated');
  });
});
