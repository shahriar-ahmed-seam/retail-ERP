/**
 * Admin dashboard placeholder (task 13.1).
 *
 * Task 13.2 will replace this with the real "today's sales / today's
 * transaction count / low-stock count + quick links" surface. Until
 * then the routing tree still needs an Admin-home component to
 * redirect into; this minimal panel renders the username and links to
 * the back-office surfaces so the role-aware shell is exercisable
 * end-to-end.
 *
 * The component is intentionally hooks-free beyond `useAuth()` — the
 * real dashboard will own its own data hooks and the placeholder
 * should not anchor any structure that 13.2 has to undo.
 *
 * Validates: Requirements 14.3.
 */

import { type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '@renderer/lib/auth-context';

interface QuickLink {
  readonly to: string;
  readonly label: string;
}

const QUICK_LINKS: readonly QuickLink[] = [
  { to: '/pos', label: 'Open POS' },
  { to: '/products', label: 'Manage products' },
  { to: '/inventory/movements', label: 'Inventory movements' },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/customers', label: 'Customers' },
  { to: '/purchases', label: 'Record purchase' },
  { to: '/reports/daily', label: 'Daily sales report' },
  { to: '/reports/low-stock', label: 'Low-stock report' },
  { to: '/backup', label: 'Backups' },
  { to: '/audit', label: 'Audit log' },
];

export function DashboardPage(): ReactElement {
  const { session } = useAuth();

  return (
    <main
      data-testid="dashboard-page"
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '60rem',
        margin: '0 auto',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>Dashboard</h1>
      <p style={{ color: '#555', marginBottom: '1.5rem' }}>
        Signed in as{' '}
        <strong>{session?.username ?? 'unknown user'}</strong>{' '}
        ({session?.role ?? 'unknown role'}). Detailed dashboard
        widgets land in task 13.2 — for now use the quick links below.
      </p>

      <ul
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))',
          gap: '0.75rem',
          listStyle: 'none',
          padding: 0,
          margin: 0,
        }}
      >
        {QUICK_LINKS.map((link) => (
          <li key={link.to}>
            <Link
              to={link.to}
              data-testid={`dashboard-link-${link.to.replace(/\//g, '-').replace(/^-/, '')}`}
              style={{
                display: 'block',
                padding: '0.875rem 1rem',
                border: '1px solid #ddd',
                borderRadius: 6,
                textDecoration: 'none',
                color: '#1a1a1a',
                background: '#fafafa',
              }}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
