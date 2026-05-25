/**
 * Admin dashboard home (task 13.2).
 *
 * The Admin's daily landing page. Replaces the placeholder shipped in
 * task 13.1 with three live KPI cards and a quick-link grid:
 *
 *   - Today's sales total (sum of `Sale.grandTotal` for the day).
 *   - Today's transaction count (`COUNT(*)` of `Sale` rows for the day).
 *   - Low-stock count (number of products at or below reorder level).
 *   - Quick links to POS, products, daily report, and backups.
 *
 * Today's totals come from `reports:dailySales` for the local-day's
 * `YYYY-MM-DD` (the channel scopes the window with `[startOfDay,
 * endOfDay)` UTC — the renderer just hands it the date string so the
 * dashboard reflects the same window the daily report does). Low-stock
 * count comes from `inventory:lowStockCount`. Both calls happen in
 * parallel on mount so the page paints in a single round-trip.
 *
 * Errors surface inline as a small "Could not load" notice per card —
 * the central toast handler also surfaces `INTERNAL`/`UNAUTHENTICATED`
 * envelopes via `useApi()`, but a per-card fallback keeps the page
 * usable when one channel fails (e.g. the daily report errors but the
 * low-stock query succeeds).
 *
 * Validates: Requirements 9.1, 3.6, 14.3.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useApi } from '@renderer/lib/api';
import { useAuth } from '@renderer/lib/auth-context';

import type { DailySalesReport } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Local-date `YYYY-MM-DD` for "today" so the dashboard agrees with the
 * cashier's wall-clock day. The daily-sales report channel itself
 * normalizes the date back to UTC midnight, so this is a pure display
 * convenience — it just means a sale committed at 23:59 local on day N
 * appears in day N's totals when the cashier opens the dashboard at
 * 00:01 of day N+1 in the same timezone.
 */
function todayLocalIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

/**
 * Pretty-print a decimal-as-string at 2 dp. Mirrors the POS totals
 * surface so the Admin sees the same currency formatting they see on
 * the POS screen and on the daily report.
 */
function formatMoney(raw: string): string {
  // Cheap formatter: split on the dot and pad. Decimal.js is overkill
  // for a display-only path; the channel already returns canonicalized
  // strings.
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '0' || trimmed === '0.0') return '0.00';
  const dotIndex = trimmed.indexOf('.');
  if (dotIndex === -1) return `${trimmed}.00`;
  const intPart = trimmed.slice(0, dotIndex);
  const fracPart = trimmed.slice(dotIndex + 1);
  if (fracPart.length === 0) return `${intPart}.00`;
  if (fracPart.length === 1) return `${intPart}.${fracPart}0`;
  return `${intPart}.${fracPart.slice(0, 2)}`;
}

interface QuickLink {
  readonly to: string;
  readonly label: string;
  readonly description: string;
  readonly testId: string;
}

const QUICK_LINKS: readonly QuickLink[] = [
  {
    to: '/pos',
    label: 'Open POS',
    description: 'Start a new sale.',
    testId: 'dashboard-link-pos',
  },
  {
    to: '/products',
    label: 'Manage products',
    description: 'Catalog, prices, and reorder levels.',
    testId: 'dashboard-link-products',
  },
  {
    to: '/reports/daily',
    label: 'Daily sales report',
    description: 'Drill into today and prior days.',
    testId: 'dashboard-link-reports',
  },
  {
    to: '/backup',
    label: 'Backups',
    description: 'Snapshot and retention.',
    testId: 'dashboard-link-backup',
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DashboardPage(): ReactElement {
  const api = useApi();
  const { session } = useAuth();

  const today = useMemo(() => todayLocalIsoDate(), []);

  const [dailyReport, setDailyReport] = useState<DailySalesReport | null>(null);
  const [dailyError, setDailyError] = useState<ErrorEnvelope | null>(null);
  const [dailyLoading, setDailyLoading] = useState<boolean>(true);

  const [lowStockCount, setLowStockCount] = useState<number | null>(null);
  const [lowStockError, setLowStockError] = useState<ErrorEnvelope | null>(null);
  const [lowStockLoading, setLowStockLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setDailyLoading(true);
      const result = await api['reports:dailySales']({ date: today });
      if (cancelled) return;
      if (result.ok) {
        setDailyReport(result.value);
        setDailyError(null);
      } else {
        setDailyReport(null);
        setDailyError(result.error);
      }
      setDailyLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, today]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLowStockLoading(true);
      const result = await api['inventory:lowStockCount']();
      if (cancelled) return;
      if (result.ok) {
        setLowStockCount(result.value.count);
        setLowStockError(null);
      } else {
        setLowStockCount(null);
        setLowStockError(result.error);
      }
      setLowStockLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

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
      <header style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ marginBottom: '0.25rem' }}>Dashboard</h1>
        <p style={{ color: '#555', margin: 0 }}>
          Signed in as{' '}
          <strong>{session?.username ?? 'unknown user'}</strong> (
          {session?.role ?? 'unknown role'}). Today is{' '}
          <span data-testid="dashboard-date">{today}</span>.
        </p>
      </header>

      <section
        aria-label="Daily KPIs"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
          gap: '0.75rem',
          marginBottom: '1.5rem',
        }}
      >
        <KpiCard
          title="Today's sales total"
          testId="dashboard-card-sales-total"
          loading={dailyLoading}
          error={dailyError}
          value={
            dailyReport !== null
              ? formatMoney(dailyReport.totalRevenue)
              : null
          }
        />
        <KpiCard
          title="Today's transactions"
          testId="dashboard-card-sales-count"
          loading={dailyLoading}
          error={dailyError}
          value={
            dailyReport !== null ? String(dailyReport.salesCount) : null
          }
        />
        <KpiCard
          title="Low-stock products"
          testId="dashboard-card-low-stock"
          loading={lowStockLoading}
          error={lowStockError}
          value={lowStockCount !== null ? String(lowStockCount) : null}
          accent={
            lowStockCount !== null && lowStockCount > 0 ? 'warning' : 'neutral'
          }
        />
      </section>

      <section aria-label="Quick links">
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Quick links</h2>
        <ul
          data-testid="dashboard-quick-links"
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
                data-testid={link.testId}
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
                <strong>{link.label}</strong>
                <div
                  style={{
                    color: '#666',
                    fontSize: '0.875rem',
                    marginTop: '0.125rem',
                  }}
                >
                  {link.description}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

interface KpiCardProps {
  readonly title: string;
  readonly testId: string;
  readonly loading: boolean;
  readonly error: ErrorEnvelope | null;
  readonly value: string | null;
  readonly accent?: 'neutral' | 'warning';
}

function KpiCard({
  title,
  testId,
  loading,
  error,
  value,
  accent = 'neutral',
}: KpiCardProps): ReactElement {
  const accentBackground = accent === 'warning' ? '#fff8e6' : '#fff';
  const accentBorder = accent === 'warning' ? '#d09a3a' : '#ddd';
  return (
    <article
      data-testid={testId}
      style={{
        padding: '1rem',
        border: `1px solid ${accentBorder}`,
        borderRadius: 6,
        background: accentBackground,
      }}
    >
      <div style={{ color: '#666', fontSize: '0.875rem' }}>{title}</div>
      {loading ? (
        <div
          data-testid={`${testId}-loading`}
          style={{
            marginTop: '0.5rem',
            fontSize: '1.25rem',
            fontWeight: 600,
            color: '#999',
          }}
        >
          Loading…
        </div>
      ) : error !== null ? (
        <div
          role="alert"
          data-testid={`${testId}-error`}
          style={{
            marginTop: '0.5rem',
            color: '#c33',
            fontSize: '0.875rem',
          }}
        >
          Could not load: {error.code}
        </div>
      ) : (
        <div
          data-testid={`${testId}-value`}
          style={{
            marginTop: '0.25rem',
            fontSize: '1.5rem',
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value ?? '—'}
        </div>
      )}
    </article>
  );
}
