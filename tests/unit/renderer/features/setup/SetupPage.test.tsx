/**
 * Unit tests for the initial admin setup screen (task 3.4).
 *
 * Mirrors the LoginPage test pattern: each test installs a stub on
 * `globalThis.window.api` before mounting the component so the auth
 * context's `createInitialAdmin` call (which goes through the typed
 * `useApi()` wrapper) hits a deterministic mock.
 *
 * Coverage:
 *   - Form renders username + password + confirm + submit.
 *   - Submit disabled when fields are empty.
 *   - Submit disabled and inline mismatch hint shown when passwords
 *     don't match.
 *   - Submit forwards trimmed username + password to
 *     `setup:createInitialAdmin` and updates the auth context with the
 *     returned `SessionDTO` on success.
 *   - VALIDATION envelope from the service surfaces as an alert with
 *     code + message; password fields are cleared.
 *   - FORBIDDEN { reason: admin_already_exists } surfaces as an alert.
 *
 * Validates: Requirements 1.6, 14.2.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SetupPage } from '@renderer/features/setup/SetupPage';
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
  g.window.api = stub;
}

function uninstallApi(): void {
  delete g.window.api;
}

afterEach(() => {
  uninstallApi();
});

const validSession: SessionDTO = {
  sessionId: 'sess-setup',
  userId: 'u-admin',
  username: 'admin',
  role: 'Admin',
};

describe('<SetupPage />', () => {
  it('renders username, password, confirm-password, and submit', () => {
    render(
      <AuthProvider>
        <SetupPage />
      </AuthProvider>,
    );

    expect(screen.getByLabelText(/^username$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /create admin account/i }),
    ).toBeInTheDocument();
  });

  it('keeps the submit button disabled while any field is empty', () => {
    render(
      <AuthProvider>
        <SetupPage />
      </AuthProvider>,
    );

    expect(
      screen.getByRole('button', { name: /create admin account/i }),
    ).toBeDisabled();
  });

  it('disables the submit button when passwords do not match', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <SetupPage />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^username$/i), 'admin');
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1');
    await user.type(screen.getByLabelText(/confirm password/i), 'super-secret-2');

    expect(
      screen.getByRole('button', { name: /create admin account/i }),
    ).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/passwords do not match/i);
  });

  it('clears the mismatch hint as soon as the values match', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <SetupPage />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^password$/i), 'abcdefgh');
    await user.type(screen.getByLabelText(/confirm password/i), 'abcdef');
    expect(screen.queryByRole('status')).toHaveTextContent(/passwords do not match/i);

    await user.type(screen.getByLabelText(/confirm password/i), 'gh');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not submit when only one password field is filled', async () => {
    const createInitialAdmin = vi.fn().mockResolvedValue(Ok(validSession));
    installApi({
      'setup:createInitialAdmin': createInitialAdmin as Api['setup:createInitialAdmin'],
    });

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <SetupPage />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^username$/i), 'admin');
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1');
    // No confirm-password value typed.

    const submit = screen.getByRole('button', { name: /create admin account/i });
    expect(submit).toBeDisabled();

    await user.click(submit);
    expect(createInitialAdmin).not.toHaveBeenCalled();
  });

  it('forwards submit to setup:createInitialAdmin and updates the auth context on success', async () => {
    const createInitialAdmin = vi.fn().mockResolvedValue(Ok(validSession));
    installApi({
      'setup:createInitialAdmin': createInitialAdmin as Api['setup:createInitialAdmin'],
    });

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
        <SetupPage />
        <CurrentSession />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^username$/i), 'admin');
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1');
    await user.type(screen.getByLabelText(/confirm password/i), 'super-secret-1');
    await user.click(screen.getByRole('button', { name: /create admin account/i }));

    await waitFor(() => {
      expect(createInitialAdmin).toHaveBeenCalledTimes(1);
    });
    expect(createInitialAdmin).toHaveBeenCalledWith({
      username: 'admin',
      password: 'super-secret-1',
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-readout')).toHaveTextContent('admin:Admin');
    });
  });

  it('trims the username before submission', async () => {
    const createInitialAdmin = vi.fn().mockResolvedValue(Ok(validSession));
    installApi({
      'setup:createInitialAdmin': createInitialAdmin as Api['setup:createInitialAdmin'],
    });

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <SetupPage />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^username$/i), '  admin  ');
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1');
    await user.type(screen.getByLabelText(/confirm password/i), 'super-secret-1');
    await user.click(screen.getByRole('button', { name: /create admin account/i }));

    await waitFor(() => {
      expect(createInitialAdmin).toHaveBeenCalledWith({
        username: 'admin',
        password: 'super-secret-1',
      });
    });
  });

  it('renders a VALIDATION error and clears both password fields', async () => {
    const createInitialAdmin = vi
      .fn()
      .mockResolvedValue(Err('VALIDATION', { field: 'password' }));
    installApi({
      'setup:createInitialAdmin': createInitialAdmin as Api['setup:createInitialAdmin'],
    });

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <SetupPage />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^username$/i), 'admin');
    await user.type(screen.getByLabelText(/^password$/i), 'short!!1');
    await user.type(screen.getByLabelText(/confirm password/i), 'short!!1');
    await user.click(screen.getByRole('button', { name: /create admin account/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('VALIDATION');

    // Username preserved; passwords cleared.
    expect(screen.getByLabelText(/^username$/i)).toHaveValue('admin');
    expect(screen.getByLabelText(/^password$/i)).toHaveValue('');
    expect(screen.getByLabelText(/confirm password/i)).toHaveValue('');
  });

  it('renders a FORBIDDEN error when an admin already exists', async () => {
    const createInitialAdmin = vi
      .fn()
      .mockResolvedValue(Err('FORBIDDEN', { reason: 'admin_already_exists' }));
    installApi({
      'setup:createInitialAdmin': createInitialAdmin as Api['setup:createInitialAdmin'],
    });

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <SetupPage />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^username$/i), 'admin');
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1');
    await user.type(screen.getByLabelText(/confirm password/i), 'super-secret-1');
    await user.click(screen.getByRole('button', { name: /create admin account/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('FORBIDDEN');
  });
});
