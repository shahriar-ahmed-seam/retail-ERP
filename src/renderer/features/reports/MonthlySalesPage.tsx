/**
 * Monthly sales report page (task 10.8, Phase 10).
 *
 * Admin-only entry point for the `reports:monthlySales` channel
 * (`ReportService.monthlySales` in main, Phase 10 task 10.2).
 * Mirrors `DailySalesPage` minus the per-payment-method breakdown
 * (the monthly report is headline figures only — Req 9.2).
 *
 * Validates: Requirements 9.2, 9.5, 8.2.
 */

// TODO(13.1): mount via role-aware shell
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import { useApi } from '@renderer/lib/api';
import { useAuth } from '@renderer/lib/auth-context';

import {
  ExportButtonRow,
  ReportHeader,
  ReportMessage,
  TotalsCardGrid,
  formatLocalMonthInput,
  useReportExport,
} from './shared';

import type { MonthlySalesReport } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

export function MonthlySalesPage(): ReactElement {
  const { session } = useAuth();
  if (session?.role !== 'Admin') {
    return (
      <ReportMessage
        testId="monthly-sales-permission-denied"
        title="Permission denied"
        body="The monthly sales report is restricted to the Admin role."
        role="alert"
      />
    );
  }
  return <MonthlySalesPageInner />;
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function MonthlySalesPageInner(): ReactElement {
  const api = useApi();
  const idPrefix = useId();

  const [month, setMonth] = useState<string>(() =>
    formatLocalMonthInput(new Date()),
  );

  const [report, setReport] = useState<MonthlySalesReport | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<ErrorEnvelope | null>(null);

  const epochRef = useRef<number>(0);
  useEffect(() => {
    return () => {
      epochRef.current += 1;
    };
  }, []);

  const fetchReport = useCallback(
    (forMonth: string): void => {
      epochRef.current += 1;
      const myEpoch = epochRef.current;
      setIsLoading(true);
      setLoadError(null);

      void (async () => {
        const result = await api['reports:monthlySales']({ month: forMonth });
        if (epochRef.current !== myEpoch) return;
        setIsLoading(false);
        if (!result.ok) {
          setLoadError(result.error);
          setReport(null);
          return;
        }
        setReport(result.value);
      })();
    },
    [api],
  );

  useEffect(() => {
    fetchReport(month);
  }, [month, fetchReport]);

  const exportFilter = useMemo(() => ({ month }), [month]);
  const exportState = useReportExport({
    reportId: 'monthlySales',
    filter: exportFilter,
  });

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '64rem',
        margin: '0 auto',
      }}
    >
      <ReportHeader
        title="Monthly sales report"
        description="Headline totals for one calendar month (UTC window). Pick a month and use the export buttons to save the underlying detail rows as CSV or PDF."
      />

      <section
        aria-label="Filters"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'flex-end',
          marginBottom: '1.5rem',
        }}
      >
        <label htmlFor={`${idPrefix}-month`} style={{ flex: '1 1 14rem' }}>
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.25rem',
            }}
          >
            Month
          </span>
          <input
            id={`${idPrefix}-month`}
            data-testid="monthly-sales-month"
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
            }}
            style={{
              width: '100%',
              padding: '0.5rem',
              boxSizing: 'border-box',
            }}
          />
        </label>
      </section>

      {loadError !== null ? (
        <ReportMessage
          testId="monthly-sales-load-error"
          title={`Failed to load report (${loadError.code})`}
          body={loadError.message}
          tone="error"
        />
      ) : null}

      {isLoading && report === null ? (
        <ReportMessage
          testId="monthly-sales-loading"
          title="Loading…"
          body="Computing monthly sales totals."
        />
      ) : null}

      {report !== null ? (
        <TotalsCardGrid
          testId="monthly-sales-totals"
          cards={[
            {
              label: 'Sales count',
              value: String(report.salesCount),
              testId: 'monthly-sales-card-count',
            },
            {
              label: 'Total revenue',
              value: report.totalRevenue,
              testId: 'monthly-sales-card-revenue',
            },
            {
              label: 'Total tax',
              value: report.totalTax,
              testId: 'monthly-sales-card-tax',
            },
            {
              label: 'Total discount',
              value: report.totalDiscount,
              testId: 'monthly-sales-card-discount',
            },
          ]}
        />
      ) : null}

      <ExportButtonRow
        testIdPrefix="monthly-sales-export"
        state={exportState}
        disabled={isLoading || report === null}
      />
    </main>
  );
}
