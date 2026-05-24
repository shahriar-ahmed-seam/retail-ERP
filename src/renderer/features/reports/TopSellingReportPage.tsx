/**
 * Top-selling report page (task 10.8, Phase 10).
 *
 * Admin-only entry point for the `reports:topSelling` channel
 * (`ReportService.topSelling` in main, Phase 10 task 10.4). Returns
 * the products ordered by units sold (descending) within
 * `[dateFrom, dateTo]` (inclusive on both ends — Req 9.4).
 *
 * The service caps the result to `TOP_SELLING_MAX_LIMIT` (200), so
 * the preview table cannot exceed 200 rows in V1. Rendered through a
 * row-virtualized list anyway so the implementation stays consistent
 * with the design (Req 16.5) and extending the limit later does not
 * require revisiting this page.
 *
 * Validates: Requirements 9.4, 9.5, 8.2, 16.5.
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
import { List, type RowComponentProps } from 'react-window';

import { useApi } from '@renderer/lib/api';
import { useAuth } from '@renderer/lib/auth-context';

import {
  ExportButtonRow,
  ReportHeader,
  ReportMessage,
  formatLocalDateInput,
  subtractDays,
  useReportExport,
} from './shared';

import type { TopSellingRow } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 44;
const TABLE_HEIGHT = 480;
const ROW_GRID_COLUMNS = '12rem 1fr 8rem 8rem';

const DEFAULT_RANGE_DAYS = 30;

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

export function TopSellingReportPage(): ReactElement {
  const { session } = useAuth();
  if (session?.role !== 'Admin') {
    return (
      <ReportMessage
        testId="top-selling-permission-denied"
        title="Permission denied"
        body="The top-selling report is restricted to the Admin role."
        role="alert"
      />
    );
  }
  return <TopSellingReportPageInner />;
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function TopSellingReportPageInner(): ReactElement {
  const api = useApi();
  const idPrefix = useId();

  // Default range: last 30 days inclusive of today. Computed once via
  // `useState` initializers so the values do not silently roll over
  // if the page sits open across midnight.
  const [dateFrom, setDateFrom] = useState<string>(() => {
    const today = new Date();
    return formatLocalDateInput(subtractDays(today, DEFAULT_RANGE_DAYS - 1));
  });
  const [dateTo, setDateTo] = useState<string>(() =>
    formatLocalDateInput(new Date()),
  );

  const [rows, setRows] = useState<readonly TopSellingRow[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<ErrorEnvelope | null>(null);

  const epochRef = useRef<number>(0);
  useEffect(() => {
    return () => {
      epochRef.current += 1;
    };
  }, []);

  const fetchReport = useCallback(
    (from: string, to: string): void => {
      epochRef.current += 1;
      const myEpoch = epochRef.current;
      setIsLoading(true);
      setLoadError(null);

      void (async () => {
        const result = await api['reports:topSelling']({
          dateFrom: from,
          dateTo: to,
        });
        if (epochRef.current !== myEpoch) return;
        setIsLoading(false);
        if (!result.ok) {
          setLoadError(result.error);
          setRows([]);
          return;
        }
        setRows(result.value.rows);
      })();
    },
    [api],
  );

  useEffect(() => {
    fetchReport(dateFrom, dateTo);
  }, [dateFrom, dateTo, fetchReport]);

  const exportFilter = useMemo(
    () => ({ dateFrom, dateTo }),
    [dateFrom, dateTo],
  );
  const exportState = useReportExport({
    reportId: 'topSelling',
    filter: exportFilter,
  });

  const rowProps = useMemo<RowContext>(() => ({ rows }), [rows]);

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
        title="Top-selling report"
        description="Products ranked by units sold within the selected date range. The default range is the last 30 days."
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
        <label htmlFor={`${idPrefix}-from`} style={{ flex: '1 1 12rem' }}>
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.25rem',
            }}
          >
            From
          </span>
          <input
            id={`${idPrefix}-from`}
            data-testid="top-selling-date-from"
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
            }}
            style={{
              width: '100%',
              padding: '0.5rem',
              boxSizing: 'border-box',
            }}
          />
        </label>
        <label htmlFor={`${idPrefix}-to`} style={{ flex: '1 1 12rem' }}>
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.25rem',
            }}
          >
            To
          </span>
          <input
            id={`${idPrefix}-to`}
            data-testid="top-selling-date-to"
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
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
          testId="top-selling-load-error"
          title={`Failed to load report (${loadError.code})`}
          body={loadError.message}
          tone="error"
        />
      ) : null}

      {isLoading && rows.length === 0 ? (
        <ReportMessage
          testId="top-selling-loading"
          title="Loading…"
          body="Computing top-selling products."
        />
      ) : null}

      {rows.length === 0 && !isLoading && loadError === null ? (
        <ReportMessage
          testId="top-selling-empty"
          title="No sales in this range"
          body="No products were sold between the selected dates."
        />
      ) : null}

      {rows.length > 0 ? (
        <>
          <TopSellingTableHeader />
          <List<RowContext>
            rowComponent={TopSellingRowItem}
            rowCount={rows.length}
            rowHeight={ROW_HEIGHT}
            rowProps={rowProps}
            defaultHeight={TABLE_HEIGHT}
            style={{ height: TABLE_HEIGHT }}
            data-testid="top-selling-virtualized-list"
          />
        </>
      ) : null}

      <ExportButtonRow
        testIdPrefix="top-selling-export"
        state={exportState}
        disabled={isLoading}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Header + virtualized row
// ---------------------------------------------------------------------------

function TopSellingTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="top-selling-table-header"
      style={{
        display: 'grid',
        gridTemplateColumns: ROW_GRID_COLUMNS,
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        fontWeight: 600,
        background: '#f7f7f7',
        borderBottom: '1px solid #ddd',
      }}
    >
      <span>SKU</span>
      <span>Name</span>
      <span style={{ textAlign: 'right' }}>Units sold</span>
      <span style={{ textAlign: 'right' }}>Revenue</span>
    </div>
  );
}

interface RowContext {
  readonly rows: readonly TopSellingRow[];
}

function TopSellingRowItem(props: RowComponentProps<RowContext>): ReactElement | null {
  const { index, style, rows } = props;
  const row = rows[index];
  if (row === undefined) return null;
  return (
    <div
      style={style}
      role="row"
      data-testid={`top-selling-row-${row.productId}`}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: ROW_GRID_COLUMNS,
          gap: '0.5rem',
          padding: '0.5rem 0.75rem',
          borderBottom: '1px solid #eee',
          alignItems: 'center',
          height: '100%',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ color: '#555' }}>{row.sku}</span>
        <span>{row.name}</span>
        <span
          style={{
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {row.unitsSold}
        </span>
        <span
          style={{
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {row.revenue}
        </span>
      </div>
    </div>
  );
}
