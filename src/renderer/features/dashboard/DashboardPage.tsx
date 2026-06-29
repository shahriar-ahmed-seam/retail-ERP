/**
 * Admin dashboard home: live KPI cards (today's revenue, transaction
 * count, low-stock count) and a quick-link grid. Validates:
 * Requirements 9.1, 3.6, 14.3.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { Card, PageHeader, Spinner } from '@renderer/components/ui';
import { formatMoney, useT, type MessageKey } from '@renderer/i18n';
import { useApi } from '@renderer/lib/api';

import type { DailySalesReport } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

function todayLocalIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

interface QuickLink {
  readonly to: string;
  readonly labelKey: MessageKey;
  readonly testId: string;
}

const QUICK_LINKS: readonly QuickLink[] = [
  { to: '/pos', labelKey: 'dashboard.openPos', testId: 'dashboard-link-pos' },
  {
    to: '/products',
    labelKey: 'dashboard.manageProducts',
    testId: 'dashboard-link-products',
  },
  {
    to: '/reports/daily',
    labelKey: 'dashboard.viewReports',
    testId: 'dashboard-link-reports',
  },
  { to: '/backup', labelKey: 'dashboard.backups', testId: 'dashboard-link-backup' },
];

export function DashboardPage(): ReactElement {
  const api = useApi();
  const t = useT();

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
    <main data-testid="dashboard-page" className="page">
      <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.subtitle')} />

      <section aria-label="Daily KPIs" className="stat-grid" style={{ marginBottom: 'var(--space-8)' }}>
        <KpiCard
          title={t('dashboard.todaySales')}
          testId="dashboard-card-sales-total"
          loading={dailyLoading}
          error={dailyError}
          value={dailyReport !== null ? formatMoney(dailyReport.totalRevenue) : null}
          accent
        />
        <KpiCard
          title={t('dashboard.todayTransactions')}
          testId="dashboard-card-sales-count"
          loading={dailyLoading}
          error={dailyError}
          value={dailyReport !== null ? String(dailyReport.salesCount) : null}
        />
        <KpiCard
          title={t('dashboard.lowStock')}
          testId="dashboard-card-low-stock"
          loading={lowStockLoading}
          error={lowStockError}
          value={lowStockCount !== null ? String(lowStockCount) : null}
        />
      </section>

      <section aria-label="Quick links">
        <h2 style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-4)' }}>
          {t('dashboard.quickLinks')}
        </h2>
        <ul data-testid="dashboard-quick-links" className="quick-links">
          {QUICK_LINKS.map((link) => (
            <li key={link.to}>
              <Link to={link.to} data-testid={link.testId} className="quick-link card">
                <span className="quick-link__label">{t(link.labelKey)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

interface KpiCardProps {
  readonly title: string;
  readonly testId: string;
  readonly loading: boolean;
  readonly error: ErrorEnvelope | null;
  readonly value: string | null;
  readonly accent?: boolean;
}

function KpiCard({
  title,
  testId,
  loading,
  error,
  value,
  accent = false,
}: KpiCardProps): ReactElement {
  return (
    <Card data-testid={testId} className="stat">
      <div className="stat__label">{title}</div>
      {loading ? (
        <div data-testid={`${testId}-loading`} className="stat__value">
          <Spinner />
        </div>
      ) : error !== null ? (
        <div role="alert" data-testid={`${testId}-error`} className="field__error">
          {error.code}
        </div>
      ) : (
        <div
          data-testid={`${testId}-value`}
          className={accent ? 'stat__value stat__value--accent' : 'stat__value'}
        >
          {value ?? '—'}
        </div>
      )}
    </Card>
  );
}
