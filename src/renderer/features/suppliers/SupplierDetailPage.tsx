/**
 * Supplier detail page (task 6.1, Phase 6).
 *
 * Shows the supplier record (name, phone, address) and a paginated
 * page of the supplier's purchase history (Req 6.3, ordered by
 * `(createdAt DESC, id)`). The detail data is fetched via the
 * `suppliers:detail` channel which returns
 * `{ supplier, history: ListResponse<PurchaseSummaryDTO> }` in one
 * round trip.
 *
 * Pagination flow: the first page comes back with the supplier
 * record. When the user clicks "Load more", the renderer re-calls
 * the same channel with the previous response's `nextCursor` baked
 * into `req.history.cursor`; the supplier slice is identical on
 * every response so we just append the new rows to the local
 * accumulated buffer. Walking pages stops when `nextCursor === null`
 * (Req 16.2).
 *
 * Validates: Requirements 6.1, 6.3, 8.2, 16.1, 16.2, 16.3.
 */

import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
} from 'react';

import { useApi } from '@renderer/lib/api';

import type {
  PurchaseSummaryDTO,
  SupplierDTO,
} from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SupplierDetailPageProps {
  readonly supplierId: string;
  /** Called when the user clicks "Back" to return to the list view. */
  readonly onClose: () => void;
  /**
   * Optional "edit" entry point. When provided, renders an Edit
   * button in the header that hands the loaded supplier DTO to the
   * parent so it can switch to the form view without a second
   * fetch.
   */
  readonly onEdit?: (supplier: SupplierDTO) => void;
}

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

interface DetailState {
  readonly supplier: SupplierDTO | null;
  readonly rows: readonly PurchaseSummaryDTO[];
  readonly nextCursor: string | null;
  readonly totalCount: number | undefined;
  readonly isLoading: boolean;
  readonly error: ErrorEnvelope | null;
}

const HISTORY_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SupplierDetailPage({
  supplierId,
  onClose,
  onEdit,
}: SupplierDetailPageProps): ReactElement {
  const api = useApi();

  const [state, setState] = useState<DetailState>({
    supplier: null,
    rows: [],
    nextCursor: null,
    totalCount: undefined,
    isLoading: false,
    error: null,
  });

  // Single fetch path used by both initial load and "Load more". The
  // supplier slice on the response is identical across pages, but
  // the rows append to the accumulated buffer.
  const fetchPage = useCallback(
    async (cursor: string | null, isReset: boolean): Promise<void> => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));
      const result = await api['suppliers:detail']({
        id: supplierId,
        history: {
          pageSize: HISTORY_PAGE_SIZE,
          withCount: true,
          ...(cursor !== null ? { cursor } : {}),
        },
      });
      if (!result.ok) {
        setState((prev) => ({ ...prev, isLoading: false, error: result.error }));
        return;
      }
      const { supplier, history } = result.value;
      setState((prev) => ({
        supplier,
        rows: isReset ? [...history.rows] : [...prev.rows, ...history.rows],
        nextCursor: history.nextCursor,
        totalCount: history.totalCount ?? prev.totalCount,
        isLoading: false,
        error: null,
      }));
    },
    [api, supplierId],
  );

  // Initial load on mount + on supplierId change.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await fetchPage(null, true);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  const loadMore = useCallback((): void => {
    if (state.isLoading || state.nextCursor === null) return;
    void fetchPage(state.nextCursor, false);
  }, [fetchPage, state.isLoading, state.nextCursor]);

  // ----- Error / loading branches ----------------------------------------
  if (state.error !== null && state.supplier === null) {
    return (
      <NotFoundOrError
        error={state.error}
        onBack={onClose}
      />
    );
  }

  if (state.supplier === null) {
    return (
      <main
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          textAlign: 'center',
          color: '#555',
        }}
        data-testid="supplier-detail-loading"
      >
        Loading supplier…
      </main>
    );
  }

  const supplier = state.supplier;
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '64rem',
        margin: '0 auto',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '1rem',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          data-testid="supplier-detail-back"
          style={{ padding: '0.375rem 0.75rem' }}
        >
          ← Back
        </button>
        {onEdit !== undefined ? (
          <button
            type="button"
            onClick={() => {
              onEdit(supplier);
            }}
            data-testid="supplier-detail-edit"
            style={{ padding: '0.375rem 0.75rem' }}
          >
            Edit
          </button>
        ) : null}
      </header>

      <section
        aria-label="Supplier"
        data-testid="supplier-detail-card"
        style={{
          padding: '1rem',
          border: '1px solid #ddd',
          borderRadius: 4,
          background: '#fafafa',
          marginBottom: '1.5rem',
        }}
      >
        <h1 style={{ margin: '0 0 0.5rem 0' }} data-testid="supplier-detail-name">
          {supplier.name}
        </h1>
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: '8rem 1fr',
            gap: '0.5rem',
            margin: 0,
          }}
        >
          <dt style={{ color: '#555' }}>Phone</dt>
          <dd
            style={{ margin: 0 }}
            data-testid="supplier-detail-phone"
          >
            {supplier.phone ?? '—'}
          </dd>
          <dt style={{ color: '#555' }}>Address</dt>
          <dd
            style={{ margin: 0 }}
            data-testid="supplier-detail-address"
          >
            {supplier.address ?? '—'}
          </dd>
        </dl>
      </section>

      <section aria-label="Purchase history">
        <h2 style={{ marginBottom: '0.5rem' }}>Purchase history</h2>
        <p style={{ color: '#555', marginTop: 0, marginBottom: '0.75rem' }}>
          {state.totalCount !== undefined
            ? `Showing ${String(state.rows.length)} of ${String(state.totalCount)}`
            : `Showing ${String(state.rows.length)}${state.nextCursor === null ? '' : '+'}`}
        </p>

        {state.rows.length === 0 && !state.isLoading ? (
          <div
            data-testid="supplier-detail-history-empty"
            style={{ padding: '1.5rem', textAlign: 'center', color: '#666' }}
          >
            No purchases recorded for this supplier yet.
          </div>
        ) : (
          <PurchaseHistoryTable rows={state.rows} />
        )}

        {state.error !== null && state.supplier !== null ? (
          <div
            role="alert"
            data-testid="supplier-detail-history-error"
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem 0.75rem',
              border: '1px solid #c33',
              color: '#c33',
              background: '#fff5f5',
              borderRadius: 4,
            }}
          >
            {state.error.code}: {state.error.message}
          </div>
        ) : null}

        {state.nextCursor !== null ? (
          <div style={{ marginTop: '0.75rem', textAlign: 'center' }}>
            <button
              type="button"
              onClick={loadMore}
              disabled={state.isLoading}
              data-testid="supplier-detail-load-more"
              style={{ padding: '0.5rem 1rem' }}
            >
              {state.isLoading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Purchase history table (static — fits in the detail page; the
// supplier history is unlikely to exceed a few hundred rows so the
// shared <VirtualizedTable> would be overkill here).
// ---------------------------------------------------------------------------

interface PurchaseHistoryTableProps {
  readonly rows: readonly PurchaseSummaryDTO[];
}

function PurchaseHistoryTable({ rows }: PurchaseHistoryTableProps): ReactElement {
  return (
    <div
      role="table"
      data-testid="supplier-detail-history-table"
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
          gridTemplateColumns: '12rem 1fr 6rem 8rem',
          gap: '0.5rem',
          padding: '0.5rem 0.75rem',
          fontWeight: 600,
          background: '#f7f7f7',
          borderBottom: '1px solid #ddd',
        }}
      >
        <span>Date</span>
        <span>Invoice</span>
        <span style={{ textAlign: 'right' }}>Items</span>
        <span style={{ textAlign: 'right' }}>Total</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.id}
          role="row"
          data-testid={`supplier-detail-history-row-${r.id}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '12rem 1fr 6rem 8rem',
            gap: '0.5rem',
            padding: '0.5rem 0.75rem',
            borderBottom: '1px solid #eee',
          }}
        >
          <span title={r.createdAt}>{formatDate(r.createdAt)}</span>
          <span style={{ color: '#555' }}>{r.invoiceNo ?? '—'}</span>
          <span style={{ textAlign: 'right' }}>{r.itemCount}</span>
          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {r.total}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

interface NotFoundOrErrorProps {
  readonly error: ErrorEnvelope;
  readonly onBack: () => void;
}

function NotFoundOrError({ error, onBack }: NotFoundOrErrorProps): ReactElement {
  const isNotFound =
    error.code === 'FK_VIOLATION' &&
    (error.details as { reason?: unknown } | undefined)?.reason === 'not_found';

  return (
    <main
      role="alert"
      data-testid="supplier-detail-error"
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        maxWidth: '32rem',
        margin: '4rem auto',
        textAlign: 'center',
        color: '#555',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>
        {isNotFound ? 'Supplier not found' : 'Failed to load supplier'}
      </h1>
      <p style={{ marginBottom: '1rem' }}>
        {isNotFound ? 'The supplier may have been deleted.' : error.message}
      </p>
      <button
        type="button"
        onClick={onBack}
        data-testid="supplier-detail-error-back"
        style={{ padding: '0.5rem 1rem' }}
      >
        Back to suppliers
      </button>
    </main>
  );
}
