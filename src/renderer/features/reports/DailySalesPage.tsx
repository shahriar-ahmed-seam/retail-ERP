/**
 * Daily sales report page (task 10.8, Phase 10).
 *
 * Admin-only entry point for the `reports:dailySales` channel
 * (`ReportService.dailySales` in main, Phase 10 task 10.1). The renderer
 * surface follows Req 9.1: total cards (sales count, revenue, tax,
 * discount) plus a per-payment-method breakdown table. Driven by a
 * native `<input type="date">` which always emits a `YYYY-MM-DD`
 * string — the exact shape the service validates.
 *
 * Render contract:
 *
 *   - Date picker. Defaults to "today" in the renderer's local
 *     timezone, computed at mount. The renderer never re-derives the
 *     default after mount so a long-lived window does not silently
 *     roll over to the next day's report — the operator picks the
 *     date explicitly.
 *
 *   - Refresh fetches `reports:dailySales` on mount and on every date
 *     change. In-flight requests are dropped via an epoch counter so
 *     a rapid date pick does not let an older response overwrite the
 *     newer one (same pattern as `usePaginatedList`).
 *
 *   - Three export buttons: CSV, PDF, Both. Each posts
 *     `reports:export` with `reportId: 'dailySales'`, the active
 *     `filter: { date }`, and the requested `format`. `paths` is
 *     deliberately omitted so the main process opens
 *     `dialog.showSaveDialog` for each output. A user cancellation
 *     surfaces as `Err('USER_CANCELED')` and renders inline.
 *
 * Role gating (Req 8.2): Admin only. Cashiers and unauthenticated
 * renderers see a permission-denied surface. Defence-in-depth: the
 * IPC matrix already denies `reports:dailySales` for cashiers.
 *
 * Validates: Requirements 9.1, 9.5, 8.2.
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
  formatLocalDateInput,
  useReportExport,
} from './shared';

import type { DailySalesReport } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

export function DailySalesPage(): ReactElement {
  const { session } = useAuth();
  if (session?.role !== 'Admin') {
    return (
      <ReportMessage
        testId="daily-sales-permission-denied"
        title="Permission denied"
        body="The daily sales report is restricted to the Admin role."
        role="alert"
      />
    );
  }
  return <DailySalesPageInner />;
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function DailySalesPageInner(): ReactElement {
  const api = useApi();
  const idPrefix = useId();

  const [date, setDate] = useState<string>(() =>
    formatLocalDateInput(new Date()),
  );

  const [report, setReport] = useState<DailySalesReport | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<ErrorEnvelope | null>(null);

  // Epoch counter — drop responses for stale date selections.
  const epochRef = useRef<number>(0);
  useEffect(() => {
    return () => {
      epochRef.current += 1;
    };
  }, []);

  const fetchReport = useCallback(
    (forDate: string): void => {
      epochRef.current += 1;
      const myEpoch = epochRef.current;
      setIsLoading(true);
      setLoadError(null);

      void (async () => {
        const result = await api['reports:dailySales']({ date: forDate });
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

  // Initial load + on-change.
  useEffect(() => {
    fetchReport(date);
  }, [date, fetchReport]);

  const exportFilter = useMemo(() => ({ date }), [date]);
  const exportState = useReportExport({
    reportId: 'dailySales',
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
        title="Daily sales report"
        description="Totals and per-payment-method breakdown for one calendar day (UTC window). Pick a date and use the export buttons to save the underlying detail rows as CSV or PDF."
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
        <label htmlFor={`${idPrefix}-date`} style={{ flex: '1 1 14rem' }}>
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.25rem',
            }}
          >
            Date
          </span>
          <input
            id={`${idPrefix}-date`}
            data-testid="daily-sales-date"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
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
          testId="daily-sales-load-error"
          title={`Failed to load report (${loadError.code})`}
          body={loadError.message}
          tone="error"
        />
      ) : null}

      {isLoading && report === null ? (
        <ReportMessage
          testId="daily-sales-loading"
          title="Loading…"
          body="Computing daily sales totals."
        />
      ) : null}

      {report !== null ? (
        <>
          <TotalsCardGrid
            testId="daily-sales-totals"
            cards={[
              {
                label: 'Sales count',
                value: String(report.salesCount),
                testId: 'daily-sales-card-count',
              },
              {
                label: 'Total revenue',
                value: report.totalRevenue,
                testId: 'daily-sales-card-revenue',
              },
              {
                label: 'Total tax',
                value: report.totalTax,
                testId: 'daily-sales-card-tax',
              },
              {
                label: 'Total discount',
                value: report.totalDiscount,
                testId: 'daily-sales-card-discount',
              },
            ]}
          />

          <PaymentBreakdownTable rows={report.paymentBreakdown} />
        </>
      ) : null}

      <ExportButtonRow
        testIdPrefix="daily-sales-export"
        state={exportState}
        disabled={isLoading || report === null}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Payment breakdown table
// ---------------------------------------------------------------------------

interface PaymentBreakdownTableProps {
  readonly rows: readonly { readonly method: string; readonly amount: string }[];
}

function PaymentBreakdownTable({
  rows,
}: PaymentBreakdownTableProps): ReactElement {
  return (
    <section aria-label="Payment breakdown" style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ marginBottom: '0.5rem' }}>Payment breakdown</h2>
      {rows.length === 0 ? (
        <div
          data-testid="daily-sales-breakdown-empty"
          style={{
            padding: '1rem',
            color: '#666',
            border: '1px solid #eee',
            borderRadius: 4,
            background: '#fafafa',
          }}
        >
          No payments recorded for this day.
        </div>
      ) : (
        <div
          role="table"
          data-testid="daily-sales-breakdown-table"
          style={{
            border: '1px solid #ddd',
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          <div
            role="row"
            style={{
              display: 'grid',
              gridTemplateColumns: '12rem 1fr',
              gap: '0.5rem',
              padding: '0.5rem 0.75rem',
              fontWeight: 600,
              background: '#f7f7f7',
              borderBottom: '1px solid #ddd',
            }}
          >
            <span>Method</span>
            <span style={{ textAlign: 'right' }}>Amount</span>
          </div>
          {rows.map((row) => (
            <div
              key={row.method}
              role="row"
              data-testid={`daily-sales-breakdown-row-${row.method}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '12rem 1fr',
                gap: '0.5rem',
                padding: '0.5rem 0.75rem',
                borderBottom: '1px solid #eee',
              }}
            >
              <span>{row.method}</span>
              <span
                style={{
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {row.amount}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
