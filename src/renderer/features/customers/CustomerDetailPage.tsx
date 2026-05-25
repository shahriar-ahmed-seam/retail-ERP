/**
 * Customer detail page (task 9.2, Phase 9).
 *
 * Shows the customer record (name, phone, created-at) and a paginated
 * page of the customer's sale history (Req 7.3, ordered by
 * `(createdAt DESC, id)`). The detail data is fetched via the
 * `customers:detail` channel which returns
 * `{ customer, history: ListResponse<SaleSummaryDTO> }` in one
 * round trip.
 *
 * Pagination flow: the first page comes back with the customer
 * record. When the user clicks "Load more", the renderer re-calls
 * the same channel with the previous response's `nextCursor` baked
 * into `req.history.cursor`; the customer slice is identical on
 * every response so we just append the new rows to the local
 * accumulated buffer. Walking pages stops when `nextCursor === null`
 * (Req 16.2).
 *
 * Role gating (Req 8.3): Admin and Cashier may both browse customer
 * detail. Cashiers do not see the Edit button (`onEdit` is undefined)
 * because the dedicated management form is Admin-only per task 9.2.
 *
 * Validates: Requirements 7.1, 7.3, 8.3, 16.1, 16.2, 16.3.
 */

import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
} from 'react';

import { useApi } from '@renderer/lib/api';

import type {
  CustomerDTO,
  SaleSummaryDTO,
} from '@shared/dto/index';
import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CustomerDetailPageProps {
  readonly customerId: string;
  /** Called when the user clicks "Back" to return to the list view. */
  readonly onClose: () => void;
  /**
   * Optional "edit" entry point. When provided, renders an Edit
   * button in the header that hands the loaded customer DTO to the
   * parent so it can switch to the form view without a second
   * fetch. Omitted by callers that lack write permission (Cashier).
   */
  readonly onEdit?: (customer: CustomerDTO) => void;
}

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

interface DetailState {
  readonly customer: CustomerDTO | null;
  readonly rows: readonly SaleSummaryDTO[];
  readonly nextCursor: string | null;
  readonly totalCount: number | undefined;
  readonly isLoading: boolean;
  readonly error: ErrorEnvelope | null;
}

const HISTORY_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CustomerDetailPage({
  customerId,
  onClose,
  onEdit,
}: CustomerDetailPageProps): ReactElement {
  const api = useApi();

  const [state, setState] = useState<DetailState>({
    customer: null,
    rows: [],
    nextCursor: null,
    totalCount: undefined,
    isLoading: false,
    error: null,
  });

  // Single fetch path used by both initial load and "Load more". The
  // customer slice on the response is identical across pages, but
  // the rows append to the accumulated buffer.
  const fetchPage = useCallback(
    async (cursor: string | null, isReset: boolean): Promise<void> => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));
      const result = await api['customers:detail']({
        id: customerId,
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
      const { customer, history } = result.value;
      setState((prev) => ({
        customer,
        rows: isReset ? [...history.rows] : [...prev.rows, ...history.rows],
        nextCursor: history.nextCursor,
        totalCount: history.totalCount ?? prev.totalCount,
        isLoading: false,
        error: null,
      }));
    },
    [api, customerId],
  );

  // Initial load on mount + on customerId change.
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
  if (state.error !== null && state.customer === null) {
    return <NotFoundOrError error={state.error} onBack={onClose} />;
  }

  if (state.customer === null) {
    return (
      <main
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          textAlign: 'center',
          color: '#555',
        }}
        data-testid="customer-detail-loading"
      >
        Loading customer…
      </main>
    );
  }

  const customer = state.customer;
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
          data-testid="customer-detail-back"
          style={{ padding: '0.375rem 0.75rem' }}
        >
          ← Back
        </button>
        {onEdit !== undefined ? (
          <button
            type="button"
            onClick={() => {
              onEdit(customer);
            }}
            data-testid="customer-detail-edit"
            style={{ padding: '0.375rem 0.75rem' }}
          >
            Edit
          </button>
        ) : null}
      </header>

      <section
        aria-label="Customer"
        data-testid="customer-detail-card"
        style={{
          padding: '1rem',
          border: '1px solid #ddd',
          borderRadius: 4,
          background: '#fafafa',
          marginBottom: '1.5rem',
        }}
      >
        <h1 style={{ margin: '0 0 0.5rem 0' }} data-testid="customer-detail-name">
          {customer.name}
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
          <dd style={{ margin: 0 }} data-testid="customer-detail-phone">
            {customer.phone ?? '—'}
          </dd>
          <dt style={{ color: '#555' }}>Created</dt>
          <dd
            style={{ margin: 0 }}
            data-testid="customer-detail-created"
            title={customer.createdAt}
          >
            {formatDate(customer.createdAt)}
          </dd>
        </dl>
      </section>

      <section aria-label="Sale history">
        <h2 style={{ marginBottom: '0.5rem' }}>Sale history</h2>
        <p style={{ color: '#555', marginTop: 0, marginBottom: '0.75rem' }}>
          {state.totalCount !== undefined
            ? `Showing ${String(state.rows.length)} of ${String(state.totalCount)}`
            : `Showing ${String(state.rows.length)}${
                state.nextCursor === null ? '' : '+'
              }`}
        </p>

        {state.rows.length === 0 && !state.isLoading ? (
          <div
            data-testid="customer-detail-history-empty"
            style={{ padding: '1.5rem', textAlign: 'center', color: '#666' }}
          >
            No sales recorded for this customer yet.
          </div>
        ) : (
          <SaleHistoryTable rows={state.rows} />
        )}

        {state.error !== null && state.customer !== null ? (
          <div
            role="alert"
            data-testid="customer-detail-history-error"
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
              data-testid="customer-detail-load-more"
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
// Sale history table (static — fits in the detail page; the customer
// history is unlikely to exceed a few hundred rows so the shared
// <VirtualizedTable> would be overkill here, mirroring the supplier
// detail page's approach).
// ---------------------------------------------------------------------------

interface SaleHistoryTableProps {
  readonly rows: readonly SaleSummaryDTO[];
}

function SaleHistoryTable({ rows }: SaleHistoryTableProps): ReactElement {
  return (
    <div
      role="table"
      data-testid="customer-detail-history-table"
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
          gridTemplateColumns: '12rem 12rem 1fr 8rem',
          gap: '0.5rem',
          padding: '0.5rem 0.75rem',
          fontWeight: 600,
          background: '#f7f7f7',
          borderBottom: '1px solid #ddd',
        }}
      >
        <span>Date</span>
        <span>Invoice</span>
        <span>Cashier</span>
        <span style={{ textAlign: 'right' }}>Total</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.id}
          role="row"
          data-testid={`customer-detail-history-row-${r.id}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '12rem 12rem 1fr 8rem',
            gap: '0.5rem',
            padding: '0.5rem 0.75rem',
            borderBottom: '1px solid #eee',
          }}
        >
          <span title={r.createdAt}>{formatDateTime(r.createdAt)}</span>
          <span style={{ color: '#555' }}>{r.serialNo}</span>
          <span style={{ color: '#555' }}>{r.cashierName}</span>
          <span
            style={{
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {r.grandTotal}
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
  return d.toLocaleDateString();
}

function formatDateTime(iso: string): string {
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
      data-testid="customer-detail-error"
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
        {isNotFound ? 'Customer not found' : 'Failed to load customer'}
      </h1>
      <p style={{ marginBottom: '1rem' }}>
        {isNotFound ? 'The customer may have been deleted.' : error.message}
      </p>
      <button
        type="button"
        onClick={onBack}
        data-testid="customer-detail-error-back"
        style={{ padding: '0.5rem 1rem' }}
      >
        Back to customers
      </button>
    </main>
  );
}
