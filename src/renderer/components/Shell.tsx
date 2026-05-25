/**
 * Authenticated application shell (task 13.1, subsumes task 13.6).
 *
 * Wraps every authenticated route with:
 *   - Top bar showing the username, role badge, and a Sign out button.
 *   - Side nav whose link list depends on the active role.
 *   - The shared `<LowStockBanner />` (built in task 10.9) so it
 *     renders on every authenticated route.
 *   - `<Outlet />` for the matched child route content.
 *
 * Navigation is wired with React Router's `<NavLink>` so the active
 * link gets the `data-active="true"` attribute and an obvious styling
 * cue — that also makes the shell ergonomic to assert against in
 * unit tests without needing CSS in jsdom.
 *
 * Validates: Requirements 1.5, 8.3, 14.3, 3.6.
 */

import { type ReactElement } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { LowStockBanner } from '@renderer/components/LowStockBanner';
import { useAuth } from '@renderer/lib/auth-context';
import { roleHomeFor } from '@renderer/lib/role-home';

import type { SessionDTO } from '@shared/ipc-contract';

type Role = SessionDTO['role'];

interface NavItem {
  readonly to: string;
  readonly label: string;
  /** Roles permitted to see this item; defaults to both. */
  readonly roles: readonly Role[];
  /**
   * When `true`, only an exact match counts as active. Used for `/`
   * style routes so e.g. `/products` does not stay highlighted when
   * the user is on `/products/new`.
   */
  readonly end?: boolean;
}

/**
 * Side nav contents. The single source of truth for what the shell
 * advertises per role; `RoleGate` stays in charge of authoritative
 * access enforcement at the route level.
 */
const NAV_ITEMS: readonly NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', roles: ['Admin'] },
  { to: '/pos', label: 'POS', roles: ['Admin', 'Cashier'] },
  { to: '/products', label: 'Products', roles: ['Admin'] },
  {
    to: '/inventory/adjust',
    label: 'Adjust stock',
    roles: ['Admin'],
  },
  {
    to: '/inventory/movements',
    label: 'Movements',
    roles: ['Admin'],
  },
  { to: '/suppliers', label: 'Suppliers', roles: ['Admin'] },
  {
    to: '/customers',
    label: 'Customers',
    roles: ['Admin', 'Cashier'],
  },
  { to: '/purchases', label: 'Purchases', roles: ['Admin'] },
  {
    to: '/reports/daily',
    label: 'Daily sales',
    roles: ['Admin'],
  },
  {
    to: '/reports/monthly',
    label: 'Monthly sales',
    roles: ['Admin'],
  },
  {
    to: '/reports/low-stock',
    label: 'Low stock',
    roles: ['Admin', 'Cashier'],
  },
  {
    to: '/reports/top-selling',
    label: 'Top selling',
    roles: ['Admin'],
  },
  { to: '/backup', label: 'Backups', roles: ['Admin'] },
  { to: '/audit', label: 'Audit log', roles: ['Admin'] },
  {
    to: '/settings/printer',
    label: 'Printer settings',
    roles: ['Admin'],
  },
];

export function Shell(): ReactElement {
  const { session, logout, isLoading } = useAuth();
  const navigate = useNavigate();

  // The auth gate (`<ProtectedRoute>`) renders this component, so the
  // session is guaranteed non-null at the React level. We still guard
  // defensively to keep the type narrowing clean and to render a
  // sensible fallback if the gate is ever bypassed.
  if (session === null) {
    return (
      <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
        Loading session…
      </main>
    );
  }

  const visibleItems = NAV_ITEMS.filter((item) =>
    item.roles.includes(session.role),
  );

  const handleLogout = (): void => {
    void (async () => {
      await logout();
      // Router state in `<App />` re-renders against `session === null`
      // and the protected outlet will redirect; we still issue an
      // explicit `/login` push so the user lands deterministically on
      // login even if the redirect race ever flickers.
      navigate('/login', { replace: true });
    })();
  };

  const handleNavigateLowStock = (): void => {
    navigate('/reports/low-stock');
  };

  return (
    <div
      data-testid="app-shell"
      style={{
        fontFamily: 'system-ui, sans-serif',
        minHeight: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <LowStockBanner onNavigate={handleNavigateLowStock} />

      <header
        data-testid="shell-topbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          padding: '0.625rem 1rem',
          borderBottom: '1px solid #ddd',
          background: '#f7f7f7',
        }}
      >
        <NavLink
          to={roleHomeFor(session.role)}
          data-testid="shell-home-link"
          style={{
            textDecoration: 'none',
            color: '#1a1a1a',
            fontWeight: 600,
          }}
        >
          Core Retail ERP
        </NavLink>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
          }}
        >
          <span data-testid="shell-username" style={{ color: '#333' }}>
            {session.username}
          </span>
          <span
            data-testid="shell-role-badge"
            style={{
              padding: '0.125rem 0.5rem',
              borderRadius: 4,
              background: session.role === 'Admin' ? '#dbeafe' : '#dcfce7',
              color: session.role === 'Admin' ? '#1e40af' : '#166534',
              fontSize: '0.75rem',
              fontWeight: 600,
            }}
          >
            {session.role}
          </span>
          <button
            type="button"
            onClick={handleLogout}
            disabled={isLoading}
            data-testid="shell-logout-button"
            style={{ padding: '0.375rem 0.75rem' }}
          >
            {isLoading ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav
          data-testid="shell-sidenav"
          aria-label="Primary"
          style={{
            width: '13rem',
            borderRight: '1px solid #ddd',
            background: '#fafafa',
            padding: '0.75rem 0.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.125rem',
            overflowY: 'auto',
          }}
        >
          {visibleItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              {...(item.end !== undefined ? { end: item.end } : {})}
              data-testid={`shell-nav-${item.to.replace(/\//g, '-').replace(/^-/, '')}`}
              style={({ isActive }) => ({
                display: 'block',
                padding: '0.5rem 0.625rem',
                borderRadius: 4,
                textDecoration: 'none',
                color: isActive ? '#0c4a6e' : '#1a1a1a',
                background: isActive ? '#e0f2fe' : 'transparent',
                fontWeight: isActive ? 600 : 400,
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <section
          data-testid="shell-content"
          style={{ flex: 1, minWidth: 0, overflow: 'auto' }}
        >
          <Outlet />
        </section>
      </div>
    </div>
  );
}
