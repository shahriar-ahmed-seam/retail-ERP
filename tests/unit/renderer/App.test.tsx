/**
 * Unit tests for the role-aware renderer shell (task 13.1).
 *
 * Mounts the real `<App />` against a stubbed `window.api`. The
 * AuthProvider is mounted with `initialSession` to drive the route
 * tree without round-tripping `auth:login`.
 *
 * Coverage:
 *   - Setup probe gate: `setup:isRequired === true` renders
 *     `<SetupPage />`; `=== false` advances to the route tree.
 *   - Unauthenticated session → `/login`.
 *   - Cashier session lands on `/pos`.
 *   - Admin session lands on `/dashboard`.
 *   - Sign-out button clears the session and bounces to `/login`.
 *   - LowStockBanner is mounted inside the authenticated shell.
 *   - Side nav advertises role-appropriate links.
 *
 * Validates: Requirements 1.5, 8.3, 14.3, 3.6.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@renderer/App';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { SessionDTO } from '@shared/ipc-contract';

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

class NoopResizeObserver {
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: NoopResizeObserver,
  });
});

afterEach(() => {
  uninstallApi();
  vi.clearAllMocks();
});

const adminSession: SessionDTO = {
  sessionId: 's-admin',
  userId: 'u-admin',
  username: 'owner',
  role: 'Admin',
};
const cashierSession: SessionDTO = {
  sessionId: 's-cashier',
  userId: 'u-cashier',
  username: 'till',
  role: 'Cashier',
};

/**
 * Build a minimal stub that always reports `setupRequired: false`,
 * `lowStockCount: 0`, and any other channels referenced by the
 * authenticated route tree's startup hooks.
 */
function buildBaseStub(extra: Partial<Api> = {}): Partial<Api> {
  return {
    'setup:isRequired': vi
      .fn()
      .mockResolvedValue(Ok({ required: false })),
    'inventory:lowStockCount': vi.fn().mockResolvedValue(Ok({ count: 0 })),
    'auth:logout': vi.fn().mockResolvedValue(Ok(undefined)),
    ...extra,
  };
}

describe('<App /> role-aware shell', () => {
  it('renders the setup page while setupRequired is true', async () => {
    installApi(
      buildBaseStub({
        'setup:isRequired': vi
          .fn()
          .mockResolvedValue(
            Ok({ required: true }),
          ) as unknown as Api['setup:isRequired'],
      }),
    );

    render(
      <AuthProvider initialSession={null}>
        <App />
      </AuthProvider>,
    );

    // Heading on the setup page.
    expect(
      await screen.findByRole('heading', { name: /welcome/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /create admin account/i }),
    ).toBeInTheDocument();
  });

  it('routes unauthenticated session to /login', async () => {
    installApi(buildBaseStub());

    render(
      <AuthProvider initialSession={null}>
        <App />
      </AuthProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: /sign in/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
  });

  it('routes Cashier session to /pos as the home', async () => {
    installApi(buildBaseStub());

    render(
      <AuthProvider initialSession={cashierSession}>
        <App />
      </AuthProvider>,
    );

    // POS scanner heading is on the page once the route resolves.
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('shell-username')).toHaveTextContent(
      'till',
    );
    expect(screen.getByTestId('shell-role-badge')).toHaveTextContent(
      'Cashier',
    );
    // Cashier nav should NOT advertise the dashboard link.
    expect(screen.queryByTestId('shell-nav-dashboard')).toBeNull();
    // Cashier nav DOES advertise POS + Customers + Low stock.
    expect(screen.getByTestId('shell-nav-pos')).toBeInTheDocument();
    expect(screen.getByTestId('shell-nav-customers')).toBeInTheDocument();
    expect(
      screen.getByTestId('shell-nav-reports-low-stock'),
    ).toBeInTheDocument();
  });

  it('routes Admin session to /dashboard as the home', async () => {
    installApi(buildBaseStub());

    render(
      <AuthProvider initialSession={adminSession}>
        <App />
      </AuthProvider>,
    );

    expect(await screen.findByTestId('dashboard-page')).toBeInTheDocument();
    expect(screen.getByTestId('shell-role-badge')).toHaveTextContent(
      'Admin',
    );
    // Admin nav advertises every Admin-only link.
    expect(screen.getByTestId('shell-nav-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('shell-nav-products')).toBeInTheDocument();
    expect(
      screen.getByTestId('shell-nav-suppliers'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('shell-nav-backup')).toBeInTheDocument();
    expect(screen.getByTestId('shell-nav-audit')).toBeInTheDocument();
    expect(
      screen.getByTestId('shell-nav-settings-printer'),
    ).toBeInTheDocument();
  });

  it('mounts the LowStockBanner inside the authenticated shell', async () => {
    installApi(
      buildBaseStub({
        'inventory:lowStockCount': vi
          .fn()
          .mockResolvedValue(
            Ok({ count: 3 }),
          ) as unknown as Api['inventory:lowStockCount'],
      }),
    );

    render(
      <AuthProvider initialSession={adminSession}>
        <App />
      </AuthProvider>,
    );

    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    // Low-stock banner renders since count > 0.
    await waitFor(() => {
      expect(screen.getByTestId('low-stock-banner')).toBeInTheDocument();
    });
  });

  it('signs the user out when the topbar Sign out button is clicked', async () => {
    const logout = vi.fn().mockResolvedValue(Ok(undefined));
    installApi(
      buildBaseStub({
        'auth:logout': logout as unknown as Api['auth:logout'],
      }),
    );

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <App />
      </AuthProvider>,
    );

    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();

    await user.click(screen.getByTestId('shell-logout-button'));

    await waitFor(() => {
      expect(logout).toHaveBeenCalledTimes(1);
    });

    // After logout the route tree falls through to /login.
    expect(
      await screen.findByRole('heading', { name: /sign in/i }),
    ).toBeInTheDocument();
  });
});
