/**
 * Purchases list page (task 6.3, Phase 6).
 *
 * Read-only browser of recent purchases. Drives the shared
 * `<VirtualizedTable>` against `purchases:list` so the filter UI
 * layered on top sits over the same paginated machinery used by every
 * other list view in the app (Req 16.1, 16.3, 16.5). Cursor pagination
 * is handled by the table; this page only owns the filter inputs and
 * the row renderer.
 *
 * Render contract:
 *   - Supplier typeahead (debounced 250 ms over `suppliers:list`).
 *     Selecting a supplier sets `filter.supplierId`; clearing the
 *     selection re-opens the search input. The IPC contract keeps
 *     `search` out of the purchases list channel — supplier-name
 *     search is therefore mediated through the picker.
 *   - Date-range pickers (`dateFrom`, `dateTo`). HTML
 *     `<input type="date">` returns a `YYYY-MM-DD` string; this page
 *     widens it into an ISO 8601 timestamp at the boundaries of the
 *     selected day so the server-side `[gte, lte]` window stays
 *     inclusive (mirrors `MovementsBrowserPage`).
 *   - Optional `withCount` totals strip rendered by the shared
 *     virtualized table.
 *
 * Each row is read-only — no row-click navigation yet. Task 6.4* will
 * land a detail page; until then the rows just display the purchase
 * summary columns (created date, supplier, invoice number, items
 * count, total).
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 16.1, 16.3, 16.5.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactElement,
} from 'react';

import { VirtualizedTable } from '@renderer/components/VirtualizedTable';
import { useApi } from '@renderer/lib/api';

import type {
  PurchaseSummaryDTO,
  PurchasesFilter,
  SupplierDTO,
} from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the supplier typeahead. Mirrors
 *  PurchaseCreatePage / `usePaginatedList`. */
const SEARCH_DEBOUNCE_MS = 250;

/** Bound on the typeahead result list. */
const SEARCH_PAGE_SIZE = 20;

/** Per-row height in CSS pixels. Matches the grid header below. */
const ROW_HEIGHT = 48;

/** Visible-window height for the virtualized list. */
const TABLE_HEIGHT = 560;

/** Page size sent to `purchases:list`. Server-side default is 50. */
const PAGE_SIZE = 50;

/** Grid column template shared by header + rows. */
const ROW_GRID_COLUMNS = '12rem 1fr 10rem 6rem 8rem';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PurchasesListPage(): ReactElement {
  const api = useApi();
  const idPrefix = useId();

  // ----- Filter state ----------------------------------------------------
  const [supplier, setSupplier] = useState<SupplierDTO | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // ----- Supplier typeahead state ----------------------------------------
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<readonly SupplierDTO[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Debounce supplier search.
  useEffect(() => {
    if (query === debouncedQuery) return undefined;
    const handle = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [query, debouncedQuery]);

  // Run the supplier search against `suppliers:list` once the
  // debounced query settles. Skip when a supplier is already selected
  // or the query is empty.
  useEffect(() => {
    if (supplier !== null) return undefined;
    const trimmed = debouncedQuery.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setIsSearching(false);
      return undefined;
    }
    let cancelled = false;
    setIsSearching(true);
    void (async () => {
      const result = await api['suppliers:list']({
        search: trimmed,
        pageSize: SEARCH_PAGE_SIZE,
      });
      if (cancelled) return;
      setIsSearching(false);
      if (result.ok) {
        setResults(result.value.rows);
      } else {
        setResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, debouncedQuery, supplier]);

  const selectSupplier = useCallback((s: SupplierDTO): void => {
    setSupplier(s);
    setQuery('');
    setDebouncedQuery('');
    setResults([]);
  }, []);

  const clearSupplier = useCallback((): void => {
    setSupplier(null);
  }, []);

  // ----- Filter envelope -------------------------------------------------
  // Build the shape inline so undefined fields are absent rather than
  // explicitly `undefined` (matches `exactOptionalPropertyTypes`).
  // `useMemo` keeps the object identity stable across renders that
  // don't change any of its inputs — important so the data hook does
  // not see a content-equivalent filter as a reset trigger.
  //
  // Date inputs return `YYYY-MM-DD` strings; widen them to ISO 8601
  // timestamps at the day boundary so the server-side `[gte, lte]`
  // window covers the whole selected day inclusively.
  const filter = useMemo<PurchasesFilter | undefined>(() => {
    const f: { supplierId?: string; dateFrom?: string; dateTo?: string } = {};
    if (supplier !== null) f.supplierId = supplier.id;
    if (dateFrom !== '') f.dateFrom = `${dateFrom}T00:00:00.000Z`;
    if (dateTo !== '') f.dateTo = `${dateTo}T23:59:59.999Z`;
    return Object.keys(f).length === 0 ? undefined : f;
  }, [dateFrom, dateTo, supplier]);

  // ----- Row renderer ----------------------------------------------------
  const renderRow = useCallback(
    (row: PurchaseSummaryDTO): ReactElement => <PurchaseRow row={row} />,
    [],
  );

  // ----- Render ----------------------------------------------------------
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '76rem',
        margin: '0 auto',
      }}
    >
      <header style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Recent purchases</h1>
        <p style={{ marginTop: '0.25rem', color: '#555' }}>
          Browse purchase invoices in reverse chronological order.
        </p>
      </header>

      <section
        aria-label="Filters"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(16rem, 1fr) 10rem 10rem',
          gap: '0.75rem',
          alignItems: 'end',
          marginBottom: '1rem',
        }}
      >
        <div>
          <label
            htmlFor={`${idPrefix}-supplier-search`}
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            Supplier
          </label>
          {supplier === null ? (
            <SupplierTypeahead
              inputId={`${idPrefix}-supplier-search`}
              query={query}
              onQueryChange={setQuery}
              results={results}
              isSearching={isSearching}
              onSelect={selectSupplier}
            />
          ) : (
            <SelectedSupplierCard supplier={supplier} onClear={clearSupplier} />
          )}
        </div>

        <div>
          <label
            htmlFor={`${idPrefix}-date-from`}
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            From
          </label>
          <input
            id={`${idPrefix}-date-from`}
            data-testid="purchases-date-from"
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
            }}
            style={{ padding: '0.5rem', width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        <div>
          <label
            htmlFor={`${idPrefix}-date-to`}
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            To
          </label>
          <input
            id={`${idPrefix}-date-to`}
            data-testid="purchases-date-to"
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
            }}
            style={{ padding: '0.5rem', width: '100%', boxSizing: 'border-box' }}
          />
        </div>
      </section>

      <PurchasesTableHeader />

      <VirtualizedTable
        channel="purchases:list"
        pageSize={PAGE_SIZE}
        withCount
        {...(filter !== undefined ? { filter } : {})}
        rowHeight={ROW_HEIGHT}
        height={TABLE_HEIGHT}
        renderRow={renderRow}
        emptyState={<EmptyState />}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Static column header
// ---------------------------------------------------------------------------

function PurchasesTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="purchases-table-header"
      style={{
        display: 'grid',
        gridTemplateColumns: ROW_GRID_COLUMNS,
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        fontWeight: 600,
        borderBottom: '1px solid #ddd',
        background: '#f7f7f7',
      }}
    >
      <span>Created</span>
      <span>Supplier</span>
      <span>Invoice #</span>
      <span style={{ textAlign: 'right' }}>Items</span>
      <span style={{ textAlign: 'right' }}>Total</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Purchase row (read-only)
// ---------------------------------------------------------------------------

interface PurchaseRowProps {
  readonly row: PurchaseSummaryDTO;
}

function PurchaseRow({ row }: PurchaseRowProps): ReactElement {
  return (
    <div
      role="row"
      data-testid={`purchases-row-${row.id}`}
      data-purchase-id={row.id}
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
      <span title={row.createdAt}>{formatTimestamp(row.createdAt)}</span>
      <span>{row.supplierName}</span>
      <span style={{ color: '#555' }}>{row.invoiceNo ?? '—'}</span>
      <span style={{ textAlign: 'right' }}>{row.itemCount}</span>
      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {row.total}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplier typeahead
// ---------------------------------------------------------------------------

interface SupplierTypeaheadProps {
  readonly inputId: string;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly results: readonly SupplierDTO[];
  readonly isSearching: boolean;
  readonly onSelect: (supplier: SupplierDTO) => void;
}

function SupplierTypeahead({
  inputId,
  query,
  onQueryChange,
  results,
  isSearching,
  onSelect,
}: SupplierTypeaheadProps): ReactElement {
  const showResults = query.trim().length > 0;
  return (
    <div>
      <input
        id={inputId}
        data-testid="purchases-supplier-search"
        type="search"
        autoComplete="off"
        placeholder="Search suppliers by name"
        value={query}
        onChange={(e) => {
          onQueryChange(e.target.value);
        }}
        style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
      />
      {showResults ? (
        <ul
          role="listbox"
          aria-label="Supplier search results"
          data-testid="purchases-supplier-results"
          style={{
            listStyle: 'none',
            margin: '0.25rem 0 0',
            padding: 0,
            border: '1px solid #ddd',
            borderRadius: 4,
            maxHeight: '14rem',
            overflowY: 'auto',
            background: '#fff',
          }}
        >
          {isSearching && results.length === 0 ? (
            <li
              data-testid="purchases-supplier-results-loading"
              style={{ padding: '0.5rem 0.75rem', color: '#777' }}
            >
              Searching…
            </li>
          ) : null}
          {!isSearching && results.length === 0 ? (
            <li
              data-testid="purchases-supplier-results-empty"
              style={{ padding: '0.5rem 0.75rem', color: '#777' }}
            >
              No matching suppliers.
            </li>
          ) : null}
          {results.map((s) => (
            <li key={s.id} role="option" aria-selected="false">
              <button
                type="button"
                data-testid={`purchases-supplier-result-${s.id}`}
                onClick={() => {
                  onSelect(s);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '0.5rem 0.75rem',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid #eee',
                  cursor: 'pointer',
                }}
              >
                <strong>{s.name}</strong>
                {s.phone !== null ? (
                  <span style={{ color: '#777', marginLeft: '0.5rem' }}>
                    {s.phone}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface SelectedSupplierCardProps {
  readonly supplier: SupplierDTO;
  readonly onClear: () => void;
}

function SelectedSupplierCard({
  supplier,
  onClear,
}: SelectedSupplierCardProps): ReactElement {
  return (
    <div
      data-testid="purchases-supplier-selected"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        border: '1px solid #cde',
        background: '#f3f8ff',
        borderRadius: 4,
      }}
    >
      <div>
        <strong data-testid="purchases-supplier-selected-name">
          {supplier.name}
        </strong>
        {supplier.phone !== null ? (
          <div style={{ color: '#555', fontSize: '0.875rem' }}>{supplier.phone}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onClear}
        data-testid="purchases-supplier-clear"
        style={{ padding: '0.25rem 0.5rem' }}
      >
        Change
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState(): ReactElement {
  return (
    <div
      data-testid="purchases-empty"
      style={{ padding: '2rem', textAlign: 'center', color: '#666' }}
    >
      No purchases match the current filters.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO 8601 timestamp for the table cell. Uses
 * `toLocaleString` for the user's locale; fails open by returning the
 * raw string when the input is unparseable so a malformed timestamp
 * does not break the row render.
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
