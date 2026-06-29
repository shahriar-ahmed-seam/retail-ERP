/**
 * Authenticated application shell: topbar (brand, language toggle, user,
 * sign out), grouped role-aware side nav, low-stock banner, and the
 * routed content outlet. Validates: Requirements 1.5, 8.3, 14.3, 3.6.
 */

import { type ReactElement } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { LowStockBanner } from '@renderer/components/LowStockBanner';
import { Badge, Brand, Button, LanguageToggle } from '@renderer/components/ui';
import { useT } from '@renderer/i18n';
import { useAuth } from '@renderer/lib/auth-context';
import { roleHomeFor } from '@renderer/lib/role-home';

import type { MessageKey } from '@renderer/i18n';
import type { SessionDTO } from '@shared/ipc-contract';

import './Shell.css';

type Role = SessionDTO['role'];

interface NavItem {
  readonly to: string;
  readonly labelKey: MessageKey;
  readonly roles: readonly Role[];
  readonly end?: boolean;
}

interface NavGroup {
  readonly titleKey: MessageKey;
  readonly items: readonly NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    titleKey: 'nav.groupSell',
    items: [
      { to: '/dashboard', labelKey: 'nav.dashboard', roles: ['Admin'] },
      { to: '/pos', labelKey: 'nav.pos', roles: ['Admin', 'Cashier'] },
    ],
  },
  {
    titleKey: 'nav.groupCatalog',
    items: [{ to: '/products', labelKey: 'nav.products', roles: ['Admin'] }],
  },
  {
    titleKey: 'nav.groupInventory',
    items: [
      { to: '/inventory/adjust', labelKey: 'nav.adjustStock', roles: ['Admin'] },
      { to: '/inventory/movements', labelKey: 'nav.movements', roles: ['Admin'] },
    ],
  },
  {
    titleKey: 'nav.groupContacts',
    items: [
      { to: '/suppliers', labelKey: 'nav.suppliers', roles: ['Admin'] },
      { to: '/customers', labelKey: 'nav.customers', roles: ['Admin', 'Cashier'] },
      { to: '/purchases', labelKey: 'nav.purchases', roles: ['Admin'] },
    ],
  },
  {
    titleKey: 'nav.groupReports',
    items: [
      { to: '/reports/daily', labelKey: 'nav.reportsDaily', roles: ['Admin'] },
      { to: '/reports/monthly', labelKey: 'nav.reportsMonthly', roles: ['Admin'] },
      {
        to: '/reports/low-stock',
        labelKey: 'nav.reportsLowStock',
        roles: ['Admin', 'Cashier'],
      },
      {
        to: '/reports/top-selling',
        labelKey: 'nav.reportsTopSelling',
        roles: ['Admin'],
      },
    ],
  },
  {
    titleKey: 'nav.groupSystem',
    items: [
      { to: '/backup', labelKey: 'nav.backup', roles: ['Admin'] },
      { to: '/audit', labelKey: 'nav.audit', roles: ['Admin'] },
      { to: '/settings/printer', labelKey: 'nav.settings', roles: ['Admin'] },
    ],
  },
];

function navTestId(to: string): string {
  return `shell-nav-${to.replace(/\//g, '-').replace(/^-/, '')}`;
}

export function Shell(): ReactElement {
  const t = useT();
  const { session, logout, isLoading } = useAuth();
  const navigate = useNavigate();

  if (session === null) {
    return <main className="page">{t('common.loading')}</main>;
  }

  const role = session.role;

  const handleLogout = (): void => {
    void (async () => {
      await logout();
      navigate('/login', { replace: true });
    })();
  };

  return (
    <div data-testid="app-shell" className="shell">
      <LowStockBanner onNavigate={() => { navigate('/reports/low-stock'); }} />

      <header data-testid="shell-topbar" className="shell__topbar">
        <NavLink
          to={roleHomeFor(role)}
          data-testid="shell-home-link"
          className="shell__brand-link"
        >
          <Brand />
        </NavLink>

        <div className="shell__topbar-right">
          <LanguageToggle />
          <span data-testid="shell-username" className="shell__username">
            {session.username}
          </span>
          <span data-testid="shell-role-badge">
            <Badge tone={role === 'Admin' ? 'primary' : 'success'}>{role}</Badge>
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleLogout}
            disabled={isLoading}
            data-testid="shell-logout-button"
          >
            {isLoading ? t('auth.signingOut') : t('auth.signOut')}
          </Button>
        </div>
      </header>

      <div className="shell__body">
        <nav data-testid="shell-sidenav" aria-label="Primary" className="shell__nav">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((i) => i.roles.includes(role));
            if (items.length === 0) return null;
            return (
              <div key={group.titleKey} className="shell__nav-group">
                <div className="shell__nav-title">{t(group.titleKey)}</div>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    {...(item.end !== undefined ? { end: item.end } : {})}
                    data-testid={navTestId(item.to)}
                    className={({ isActive }) =>
                      isActive ? 'shell__nav-link is-active' : 'shell__nav-link'
                    }
                  >
                    {t(item.labelKey)}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <section data-testid="shell-content" className="shell__content">
          <Outlet />
        </section>
      </div>
    </div>
  );
}
