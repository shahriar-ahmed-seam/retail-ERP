/**
 * Inventory movements browser page (task 5.5.2, Phase 5).
 *
 * Admin-only ledger browser. Drives the shared `<VirtualizedTable>`
 * against `inventory_movements:list` so the search + filter UI layered
 * on top sits over the same paginated machinery used by every other
 * list view in the app (Req 16.1, 16.5). Cursor pagination is handled
 * by the table; this page only owns the filter inputs and the row
 * renderer.
 *
 * Render contract:
 *   - Product typeahead. Picks a product through `products:list` with a
 *     250 ms debounced `search` filter. Once a product is selected the
 *     filter envelope carries `productId`; clearing the selection
 *     re-opens the search input.
 *   - Movement-type select. `''` (default) means no filter; the four
 *     domain values are `sale | purchase | adjustment | return`.
 *   - Date-range pickers (`dateFrom`, `dateTo`). HTML `<input
 *     type="date">` returns a `YYYY-MM-DD` string; this component
 *     widens it into an ISO 8601 timestamp at the boundaries of the
 *     selected day so the server-side `[gte, lte]` window stays
 *     inclusive.
 *
 * Each row carries a click target. The originating sale, purchase, or
 * adjustment views ship with the route tree in task 13.1; until then
 * the default click handler logs a `TODO(task 13.1)` line so the
 * intent is greppable. Callers (and tests) can override the default
 * via the `onNavigate` prop.
 *
 * Role gating (Req 8.2): Admin only. The IPC matrix already rejects
 * `inventory_movements:list` for cashiers — but rendering the form
 * for a role that can't read it would be a confusing UX, so we surface
 * the permission-denied screen up front.
 *
 * Validates: Requirements 3.1, 8.2, 16.1, 16.5.
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
import { useAuth } from '@renderer/lib/auth-context';

import type {
  InventoryMovementDTO,
  MovementFilter,
  MovementType,
  ProductDTO,
  ReferenceType,
} from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

/** Click-target shape passed to {@link MovementsBrowserPageProps.onNavigate}. */
export interface MovementNavigationTarget {
  readonly referenceType: ReferenceType;
  readonly referenceId: string;
}

export interface MovementsBrowserPageProps {
  /**
   * Optional row-click navigation callback. Called with the `referenceType`
   * + `referenceId` of the clicked movement so a parent (or the future
   * router from task 13.1) can route to the originating sale,
   * purchase, or adjustment detail screen. Defaults to a console-only
   * placeholder until the route tree lands.
   */
  readonly onNavigate?: (target: MovementNavigationTarget) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the product typeahead. Mirrors AdjustPage. */
const SEARCH_DEBOUNCE_MS = 250;

/** Bound on the typeahead result list so the dropdown stays bounded. */
const SEARCH_PAGE_SIZE = 10;

/** Per-row height in CSS pixels. Matches the grid header below. */
const ROW_HEIGHT = 48;

/** Visible-window height for the virtualized list. */
const TABLE_HEIGHT = 560;

/** Page size sent to `inventory_movements:list`. Server-side default is 50. */
const PAGE_SIZE = 50;

/**
 * Movement-type select options. Keep the ordering stable so the
 * `selectOptions(...)` test helper picks up the right `<option>`.
 */
const MOVEMENT_TYPE_OPTIONS: readonly { value: MovementType; label: string }[] = [
  { value: 'sale', label: 'Sale' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'adjustment', label: 'Adjustment' },
  { value: 'return', label: 'Return' },
];

/** Grid column template shared by header + rows. */
const ROW_GRID_COLUMNS = '14rem 1fr 7rem 5rem 9rem 14rem';

// ---------------------------------------------------------------------------
// Default navigate handler
// ---------------------------------------------------------------------------

/**
 * Placeholder navigation callback. The route tree (task 13.1) lands
 * `/sales/:id`, `/purchases/:id`, and the adjustment audit-log entry,
 * at which point this default becomes a real `navigate(...)` call.
 * Logging through `console.info` keeps the intent greppable without
 * tripping test runners that promote `console.error` to a failure.
 */
const defaultNavigate = (target: MovementNavigationTarget): void => {
  // TODO(task 13.1): replace with router.navigate(...) once the route
  // tree exposes /sales/:id, /purchases/:id, and the adjustment audit
  // detail surfaces.
  console.info(
    `[MovementsBrowserPage] navigate to ${target.referenceType} ${target.referenceId} ` +
      '(router not yet wired)',
  );
};

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

/**
 * Public entry point. Splits the role gate from the page body so the
 * body can use hooks freely without violating React's hooks-order
 * invariant across the gated branch.
 */
export function MovementsBrowserPage(
  props: MovementsBrowserPageProps,
): ReactElement {
  const { session } = useAuth();

  if (session?.role !== 'Admin') {
    return <PermissionDenied />;
  }

  return <MovementsBrowserPageInner {...props} />;
}

// ---------------------------------------------------------------------------
// Permission-denied fallback
// ---------------------------------------------------------------------------

function PermissionDenied(): ReactElement {
  return (
    <main
      role="alert"
      data-testid="movements-permission-denied"
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        maxWidth: '32rem',
        margin: '4rem auto',
        textAlign: 'center',
        color: '#555',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>Permission denied</h1>
      <p>
        The inventory movement ledger is restricted to the Admin role.
        Please sign in as an administrator to continue.
      </p>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function MovementsBrowserPageInner({
  onNavigate,
}: MovementsBrowserPageProps): ReactElement {
  const api = useApi();
  const idPrefix = useId();

  // ----- Filter state ----------------------------------------------------
  const [selectedProduct, setSelectedProduct] = useState<ProductDTO | null>(null);
  const [movementType, setMovementType] = useState<'' | MovementType>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // ----- Typeahead state -------------------------------------------------
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<readonly ProductDTO[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Debounce the typeahead query. Mirrors `usePaginatedList` so the
  // renderer never floods the IPC bridge mid-keystroke.
  useEffect(() => {
    if (query === debouncedQuery) return undefined;
    const handle = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [query, debouncedQuery]);

  // Run the typeahead search when the debounced query changes. Skip
  // entirely when a product is already selected (the input is hidden
  // in that branch) or the query is empty.
  useEffect(() => {
    if (selectedProduct !== null) return undefined;
    const trimmed = debouncedQuery.trim();
    if (trimmed.length === 0) {
      setSearchResults([]);
      setIsSearching(false);
      return undefined;
    }

    let cancelled = false;
    setIsSearching(true);
    void (async () => {
      const result = await api['products:list']({
        search: trimmed,
        pageSize: SEARCH_PAGE_SIZE,
      });
      if (cancelled) return;
      setIsSearching(false);
      if (result.ok) {
        setSearchResults(result.value.rows);
      } else {
        setSearchResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, debouncedQuery, selectedProduct]);

  const selectProduct = useCallback((p: ProductDTO): void => {
    setSelectedProduct(p);
    setQuery('');
    setDebouncedQuery('');
    setSearchResults([]);
  }, []);

  const clearProduct = useCallback((): void => {
    setSelectedProduct(null);
  }, []);

  // ----- Filter envelope --------------------------------------------------
  // Build the shape inline so undefined fields are absent rather than
  // explicitly `undefined` (matches `exactOptionalPropertyTypes`).
  // `useMemo` keeps the object identity stable across renders that
  // don't change any of its inputs — important so the data hook does
  // not see a content-equivalent filter as a reset trigger.
  //
  // Date inputs return `YYYY-MM-DD` strings; widen them to ISO 8601
  // timestamps at the day boundary so the server-side `[gte, lte]`
  // window covers the whole selected day inclusively.
  const filter = useMemo<MovementFilter | undefined>(() => {
    const f: {
      productId?: string;
      movementType?: MovementType;
      dateFrom?: string;
      dateTo?: string;
    } = {};
    if (selectedProduct !== null) f.productId = selectedProduct.id;
    if (movementType !== '') f.movementType = movementType;
    if (dateFrom !== '') f.dateFrom = `${dateFrom}T00:00:00.000Z`;
    if (dateTo !== '') f.dateTo = `${dateTo}T23:59:59.999Z`;
    return Object.keys(f).length === 0 ? undefined : f;
  }, [dateFrom, dateTo, movementType, selectedProduct]);

  // ----- Row navigation --------------------------------------------------
  const navigate = onNavigate ?? defaultNavigate;
  const handleRowClick = useCallback(
    (row: InventoryMovementDTO): void => {
      navigate({
        referenceType: row.referenceType,
        referenceId: row.referenceId,
      });
    },
    [navigate],
  );

  // ----- Row renderer ----------------------------------------------------
  const renderRow = useCallback(
    (row: InventoryMovementDTO): ReactElement => (
      <MovementRow row={row} onClick={handleRowClick} />
    ),
    [handleRowClick],
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
        <h1 style={{ margin: 0 }}>Inventory movements</h1>
        <p style={{ marginTop: '0.25rem', color: '#555' }}>
          Browse the full ledger of stock changes. Click a row to open the
          originating sale, purchase, or adjustment.
        </p>
      </header>

      <section
        aria-label="Filters"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(16rem, 1fr) 12rem 10rem 10rem',
          gap: '0.75rem',
          alignItems: 'end',
          marginBottom: '1rem',
        }}
      >
        {/* Product typeahead --------------------------------------- */}
        <div>
          <label
            htmlFor={`${idPrefix}-product-search`}
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            Product
          </label>
          {selectedProduct === null ? (
            <ProductTypeahead
              inputId={`${idPrefix}-product-search`}
              query={query}
              onQueryChange={setQuery}
              results={searchResults}
              isSearching={isSearching}
              onSelect={selectProduct}
            />
          ) : (
            <SelectedProductCard
              product={selectedProduct}
              onClear={clearProduct}
            />
          )}
        </div>

        {/* Movement type ------------------------------------------- */}
        <div>
          <label
            htmlFor={`${idPrefix}-movement-type`}
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            Movement type
          </label>
          <select
            id={`${idPrefix}-movement-type`}
            data-testid="movements-type-filter"
            value={movementType}
            onChange={(e) => {
              setMovementType(e.target.value as '' | MovementType);
            }}
            style={{ padding: '0.5rem', width: '100%' }}
          >
            <option value="">All types</option>
            {MOVEMENT_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Date from ------------------------------------------------ */}
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
            data-testid="movements-date-from"
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
            }}
            style={{ padding: '0.5rem', width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        {/* Date to -------------------------------------------------- */}
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
            data-testid="movements-date-to"
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
            }}
            style={{ padding: '0.5rem', width: '100%', boxSizing: 'border-box' }}
          />
        </div>
      </section>

      <MovementsTableHeader />

      <VirtualizedTable
        channel="inventory_movements:list"
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

/**
 * Column header strip above the virtualized list. Lives outside the
 * table so it doesn't scroll out of view on long result sets — the
 * VirtualizedTable mounts only the visible window of data rows, not a
 * header.
 */
function MovementsTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="movements-table-header"
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
      <span>Timestamp</span>
      <span>Product</span>
      <span>Type</span>
      <span style={{ textAlign: 'right' }}>Qty</span>
      <span>User</span>
      <span>Reference</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Movement row
// ---------------------------------------------------------------------------

interface MovementRowProps {
  readonly row: InventoryMovementDTO;
  readonly onClick: (row: InventoryMovementDTO) => void;
}

/**
 * One ledger row. The row is keyboard-activatable (Enter / Space)
 * so the click target works for users navigating without a pointer.
 * A styled signed delta keeps positive vs. negative changes visually
 * distinct without color alone (the `+` / `−` glyph carries the
 * meaning for screen readers too).
 */
function MovementRow({ row, onClick }: MovementRowProps): ReactElement {
  const handleClick = (): void => {
    onClick(row);
  };
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(row);
    }
  };

  const deltaSign = row.quantityDelta > 0 ? '+' : '';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKey}
      data-testid={`movement-row-${row.id}`}
      data-movement-id={row.id}
      data-reference-type={row.referenceType}
      data-reference-id={row.referenceId}
      style={{
        display: 'grid',
        gridTemplateColumns: ROW_GRID_COLUMNS,
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        cursor: 'pointer',
        borderBottom: '1px solid #eee',
        alignItems: 'center',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <span title={row.timestamp}>{formatTimestamp(row.timestamp)}</span>
      <span>{row.productName}</span>
      <MovementTypeBadge type={row.movementType} />
      <span
        style={{
          textAlign: 'right',
          color: row.quantityDelta < 0 ? '#a33' : '#262',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {deltaSign}
        {row.quantityDelta}
      </span>
      <span style={{ color: '#555' }}>{row.userName}</span>
      <span style={{ color: '#555', fontSize: '0.875rem' }}>
        {row.referenceType} · {row.referenceId}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Movement-type badge
// ---------------------------------------------------------------------------

/** Background palette per movement type. Kept inline so the file
 *  stays self-contained — there is no shared design token system yet. */
const TYPE_BADGE_BG: Record<MovementType, string> = {
  sale: '#fde8e8',
  purchase: '#e6f4ea',
  adjustment: '#fff4e0',
  return: '#e8eef9',
};

function MovementTypeBadge({ type }: { type: MovementType }): ReactElement {
  return (
    <span
      data-testid={`movement-type-badge-${type}`}
      style={{
        display: 'inline-block',
        padding: '0.125rem 0.5rem',
        background: TYPE_BADGE_BG[type],
        borderRadius: 999,
        fontSize: '0.75rem',
        textTransform: 'capitalize',
      }}
    >
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Product typeahead
// ---------------------------------------------------------------------------

interface ProductTypeaheadProps {
  readonly inputId: string;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly results: readonly ProductDTO[];
  readonly isSearching: boolean;
  readonly onSelect: (product: ProductDTO) => void;
}

function ProductTypeahead({
  inputId,
  query,
  onQueryChange,
  results,
  isSearching,
  onSelect,
}: ProductTypeaheadProps): ReactElement {
  const showResults = query.trim().length > 0;
  return (
    <div>
      <input
        id={inputId}
        data-testid="movements-product-search"
        type="search"
        autoComplete="off"
        placeholder="Search by name or SKU"
        value={query}
        onChange={(e) => {
          onQueryChange(e.target.value);
        }}
        style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
      />
      {showResults ? (
        <ul
          role="listbox"
          aria-label="Product search results"
          data-testid="movements-product-results"
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
              data-testid="movements-product-results-loading"
              style={{ padding: '0.5rem 0.75rem', color: '#777' }}
            >
              Searching…
            </li>
          ) : null}
          {!isSearching && results.length === 0 ? (
            <li
              data-testid="movements-product-results-empty"
              style={{ padding: '0.5rem 0.75rem', color: '#777' }}
            >
              No matching products.
            </li>
          ) : null}
          {results.map((p) => (
            <li key={p.id} role="option" aria-selected="false">
              <button
                type="button"
                data-testid={`movements-product-result-${p.id}`}
                onClick={() => {
                  onSelect(p);
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
                <strong>{p.name}</strong>
                <span style={{ color: '#777', marginLeft: '0.5rem' }}>
                  {p.sku}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selected product card
// ---------------------------------------------------------------------------

interface SelectedProductCardProps {
  readonly product: ProductDTO;
  readonly onClear: () => void;
}

function SelectedProductCard({
  product,
  onClear,
}: SelectedProductCardProps): ReactElement {
  return (
    <div
      data-testid="movements-selected-product"
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
        <strong data-testid="movements-selected-product-name">
          {product.name}
        </strong>
        <div style={{ color: '#555', fontSize: '0.875rem' }}>{product.sku}</div>
      </div>
      <button
        type="button"
        onClick={onClear}
        data-testid="movements-selected-product-clear"
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
      data-testid="movements-empty"
      style={{ padding: '2rem', textAlign: 'center', color: '#666' }}
    >
      No movements match the current filters.
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
