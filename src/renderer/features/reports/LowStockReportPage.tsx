/**
 * Low-stock report page (task 10.8, Phase 10).
 *
 * Renders every product whose `Inventory.onHand <= Product.reorderLevel`
 * (Req 9.3, 3.6) via the `reports:lowStock` channel. Available to both
 * Admin and Cashier — the persistent `<LowStockBanner>` clicks through
 * here and the banner is visible to both roles.
 *
 * The result set is finite (bounded by the count of products below
 * the reorder threshold — typically a small fraction of the catalog),
 * so the channel returns the full row set in one envelope without
 * pagination. The preview is rendered through a row-virtualized list
 * so very large catalogs (10k+ products with lots below threshold)
 * still keep the mounted DOM count bounded (Req 16.5).
 *
 * Validates: Requirements 9.3, 9.5, 3.6, 16.5.
 */

import {
  useCallback,
  useEffect,
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
  useReportExport,
} from './shared';

import type { LowStockRow } from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 44;
const TABLE_HEIGHT = 480;
const ROW_GRID_COLUMNS = '12rem 1fr 8rem 8rem';

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

export function LowStockReportPage(): ReactElement {
  const { session } = useAuth();
  if (session === null) {
    return (
      <ReportMessage
        testId="low-stock-permission-denied"
        title="Permission denied"
        body="You must be signed in to view the low-stock report."
        role="alert"
      />
    );
  }
  return <LowStockReportPageInner />;
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function LowStockReportPageInner(): ReactElement {
  const api = useApi();

  const [rows, setRows] = useState<readonly LowStockRow[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<ErrorEnvelope | null>(null);

  const epochRef = useRef<number>(0);
  useEffect(() => {
    return () => {
      epochRef.current += 1;
    };
  }, []);

  const fetchReport = useCallback((): void => {
    epochRef.current += 1;
    const myEpoch = epochRef.current;
    setIsLoading(true);
    setLoadError(null);

    void (async () => {
      const result = await api['reports:lowStock']();
      if (epochRef.current !== myEpoch) return;
      setIsLoading(false);
      if (!result.ok) {
        setLoadError(result.error);
        setRows([]);
        return;
      }
      setRows(result.value.rows);
    })();
  }, [api]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  // Low-stock export takes no filter — the underlying SELECT mirrors
  // the read-side projection.
  const exportState = useReportExport({
    reportId: 'lowStock',
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
        title="Low-stock report"
        description="Every product whose on-hand quantity is at or below its reorder level. Use the export buttons to save the list as CSV or PDF."
      />

      <section
        aria-label="Refresh"
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1rem',
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          data-testid="low-stock-refresh"
          onClick={fetchReport}
          disabled={isLoading}
          style={{ padding: '0.5rem 1rem' }}
        >
          {isLoading ? 'Refreshing…' : 'Refresh'}
        </button>
        <span
          data-testid="low-stock-summary"
          style={{ color: '#555' }}
          aria-live="polite"
        >
          {rows.length === 0 && !isLoading && loadError === null
            ? 'All stock levels are above their reorder thresholds.'
            : `${rows.length} product${rows.length === 1 ? '' : 's'} below reorder level`}
        </span>
      </section>

      {loadError !== null ? (
        <ReportMessage
          testId="low-stock-load-error"
          title={`Failed to load report (${loadError.code})`}
          body={loadError.message}
          tone="error"
        />
      ) : null}

      {isLoading && rows.length === 0 ? (
        <ReportMessage
          testId="low-stock-loading"
          title="Loading…"
          body="Fetching low-stock summary."
        />
      ) : null}

      {rows.length > 0 ? (
        <>
          <LowStockTableHeader />
          <List<RowContext>
            rowComponent={LowStockRowItem}
            rowCount={rows.length}
            rowHeight={ROW_HEIGHT}
            rowProps={rowProps}
            defaultHeight={TABLE_HEIGHT}
            style={{ height: TABLE_HEIGHT }}
            data-testid="low-stock-virtualized-list"
          />
        </>
      ) : null}

      <ExportButtonRow
        testIdPrefix="low-stock-export"
        state={exportState}
        disabled={isLoading || rows.length === 0}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Header + virtualized row
// ---------------------------------------------------------------------------

function LowStockTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="low-stock-table-header"
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
      <span style={{ textAlign: 'right' }}>On hand</span>
      <span style={{ textAlign: 'right' }}>Reorder level</span>
    </div>
  );
}

interface RowContext {
  readonly rows: readonly LowStockRow[];
}

function LowStockRowItem(props: RowComponentProps<RowContext>): ReactElement | null {
  const { index, style, rows } = props;
  const row = rows[index];
  if (row === undefined) return null;
  return (
    <div
      style={style}
      role="row"
      data-testid={`low-stock-row-${row.productId}`}
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
            color: row.onHand === 0 ? '#c33' : '#1a6',
          }}
        >
          {row.onHand}
        </span>
        <span
          style={{
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {row.reorderLevel}
        </span>
      </div>
    </div>
  );
}
