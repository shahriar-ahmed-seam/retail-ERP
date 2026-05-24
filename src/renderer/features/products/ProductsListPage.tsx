/**
 * Products list page (task 4.4, Phase 4).
 *
 * Single-screen catalog browser for the products feature. Drives the
 * shared `<VirtualizedTable>` against `products:list` so the search +
 * filter UI layered on top sits over the same paginated machinery used
 * by every other list view in the app (Req 16.1, 16.3, 16.5).
 *
 * Render contract:
 *   - Search input. The hook owns the 250 ms debounce — we forward
 *     keystrokes directly without local debouncing.
 *   - Category filter dropdown, populated once from `categories:list`.
 *     Changing the dropdown updates the `filter` object passed to the
 *     hook, which causes a cursor reset + first-page refetch.
 *   - "Low stock only" checkbox. Adds `filter.lowStockOnly: true` to
 *     the request envelope; the server-side service compiles that into
 *     a cross-table query that returns ids where
 *     `Inventory.onHand <= Product.reorderLevel` (Req 3.6, design.md
 *     > "Server-side filter, search, sort").
 *   - "New product" button — Admin only. Cashiers see the same list
 *     but get no create / edit affordance (Req 8.3).
 *   - Each row shows SKU, name, category, sell price, on-hand. Admins
 *     can click a row to open the edit form; the row carries the full
 *     `ProductDTO` to the form so the form does not need a getById
 *     channel (which the IPC contract does not expose today — the
 *     three product channels are list, count, upsert).
 *
 * Navigation between list and form is local component state. There is
 * no router yet (task 13.1); when it lands the create / edit / cancel
 * branches become `navigate('/products/new')`-style calls and this
 * page collapses to a single "list" responsibility.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 8.3, 16.1, 16.3, 16.5.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';

import { VirtualizedTable } from '@renderer/components/VirtualizedTable';
import { useApi } from '@renderer/lib/api';
import { useAuth } from '@renderer/lib/auth-context';

import { ProductFormPage } from './ProductFormPage';

import type { CategoryDTO, ProductDTO, ProductFilter } from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Local view-state shape. The list page can be in one of three modes:
 *   - `'list'`        — table is the active surface.
 *   - `'create'`      — form is mounted with no `product` prop.
 *   - `'edit'`        — form is mounted with the row clicked in the list.
 *
 * State lives here (rather than the form) so a successful submit can
 * snap back to `'list'` and the table re-mounts a fresh first page —
 * which makes the freshly-created / edited row visible without a
 * dedicated cache-invalidation channel.
 */
type ViewMode =
  | { readonly kind: 'list' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly product: ProductDTO };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProductsListPage(): ReactElement {
  const api = useApi();
  const { session } = useAuth();
  const isAdmin = session?.role === 'Admin';

  // ----- Search + filters --------------------------------------------------
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [lowStockOnly, setLowStockOnly] = useState(false);

  // ----- Categories dropdown source ----------------------------------------
  // Loaded once on mount; categories are a tiny reference table so we
  // do not paginate. Failures are logged via the toast wrapper in
  // `useApi()`; the dropdown simply stays empty.
  const [categories, setCategories] = useState<readonly CategoryDTO[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api['categories:list']();
      if (cancelled) return;
      if (result.ok) {
        setCategories(result.value.rows);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // ----- Compose the filter envelope ---------------------------------------
  // Build the shape inline so undefined fields are absent rather than
  // explicitly `undefined` (matches `exactOptionalPropertyTypes`).
  // `useMemo` keeps the object identity stable across renders that
  // don't change any of its inputs — important so the data hook does
  // not see a content-equivalent filter as a reset trigger.
  const filter = useMemo<ProductFilter | undefined>(() => {
    const f: { categoryId?: string; lowStockOnly?: boolean } = {};
    if (categoryId !== '') f.categoryId = categoryId;
    if (lowStockOnly) f.lowStockOnly = true;
    return Object.keys(f).length === 0 ? undefined : f;
  }, [categoryId, lowStockOnly]);

  // ----- Mode-switch handlers ---------------------------------------------
  const [view, setView] = useState<ViewMode>({ kind: 'list' });

  const openCreate = useCallback((): void => {
    setView({ kind: 'create' });
  }, []);

  const openEdit = useCallback((product: ProductDTO): void => {
    setView({ kind: 'edit', product });
  }, []);

  const closeForm = useCallback((): void => {
    setView({ kind: 'list' });
  }, []);

  // ----- Row renderer ------------------------------------------------------
  // Closure captures `isAdmin` and `openEdit`; `useCallback` keeps the
  // function identity stable so the virtualized list does not re-render
  // every row on unrelated parent updates. Declared BEFORE the form-
  // branch early returns so React's hooks-order invariant holds.
  const renderRow = useCallback(
    (row: ProductDTO): ReactElement => (
      <ProductRow row={row} isAdmin={isAdmin} onEdit={openEdit} />
    ),
    [isAdmin, openEdit],
  );

  // ----- Form branch -------------------------------------------------------
  // When the form is open we render the form alone — the same single
  // "products feature surface" pattern the spec asks for. On close
  // (cancel or success) we snap back to `'list'`, which remounts the
  // <VirtualizedTable /> and fetches a fresh first page reflecting any
  // new / updated row.
  if (view.kind === 'create') {
    return <ProductFormPage onClose={closeForm} categories={categories} />;
  }
  if (view.kind === 'edit') {
    return (
      <ProductFormPage
        product={view.product}
        onClose={closeForm}
        categories={categories}
      />
    );
  }

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '72rem',
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
        <h1 style={{ margin: 0 }}>Products</h1>
        {isAdmin ? (
          <button
            type="button"
            onClick={openCreate}
            data-testid="products-new-button"
            style={{ padding: '0.5rem 1rem' }}
          >
            New product
          </button>
        ) : null}
      </header>

      <section
        aria-label="Filters"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <label htmlFor="products-search" style={{ flex: '1 1 16rem' }}>
          <span style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.125rem' }}>
            Search
          </span>
          <input
            id="products-search"
            type="search"
            value={search}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setSearch(e.target.value);
            }}
            placeholder="Name or SKU"
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
          />
        </label>

        <label htmlFor="products-category">
          <span style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.125rem' }}>
            Category
          </span>
          <select
            id="products-category"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
            }}
            style={{ padding: '0.5rem', minWidth: '12rem' }}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label
          htmlFor="products-low-stock"
          style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}
        >
          <input
            id="products-low-stock"
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => {
              setLowStockOnly(e.target.checked);
            }}
          />
          Low stock only
        </label>
      </section>

      <ProductTableHeader />

      <VirtualizedTable
        channel="products:list"
        pageSize={50}
        withCount
        search={search}
        {...(filter !== undefined ? { filter } : {})}
        rowHeight={56}
        height={560}
        renderRow={renderRow}
        emptyState={<EmptyState search={search} />}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

/**
 * Static column header strip rendered above the virtualized list. It
 * lives outside the table so it does not scroll out of view on long
 * result sets — the VirtualizedTable mounts only the visible window of
 * data rows, not a header.
 */
function ProductTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="products-table-header"
      style={{
        display: 'grid',
        gridTemplateColumns: '8rem 1fr 12rem 8rem 6rem',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        fontWeight: 600,
        borderBottom: '1px solid #ddd',
        background: '#f7f7f7',
      }}
    >
      <span>SKU</span>
      <span>Name</span>
      <span>Category</span>
      <span style={{ textAlign: 'right' }}>Sell price</span>
      <span style={{ textAlign: 'right' }}>On hand</span>
    </div>
  );
}

interface ProductRowProps {
  readonly row: ProductDTO;
  readonly isAdmin: boolean;
  readonly onEdit: (product: ProductDTO) => void;
}

/**
 * One product row. Admin users get a clickable, keyboard-activatable
 * row that opens the edit form; cashiers see a read-only line with no
 * affordances at all (Req 8.3 — Cashier role gets read-only list).
 */
function ProductRow({ row, isAdmin, onEdit }: ProductRowProps): ReactElement {
  const handleClick = (): void => {
    if (isAdmin) onEdit(row);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!isAdmin) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onEdit(row);
    }
  };

  return (
    <div
      role={isAdmin ? 'button' : undefined}
      tabIndex={isAdmin ? 0 : -1}
      onClick={isAdmin ? handleClick : undefined}
      onKeyDown={isAdmin ? handleKey : undefined}
      data-testid={`products-row-${row.id}`}
      data-product-id={row.id}
      style={{
        display: 'grid',
        gridTemplateColumns: '8rem 1fr 12rem 8rem 6rem',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        cursor: isAdmin ? 'pointer' : 'default',
        borderBottom: '1px solid #eee',
        alignItems: 'center',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <span>{row.sku}</span>
      <span>{row.name}</span>
      <span style={{ color: '#555' }}>{row.categoryName ?? '—'}</span>
      <span style={{ textAlign: 'right' }}>{row.sellPrice}</span>
      <span style={{ textAlign: 'right' }}>{row.onHand}</span>
    </div>
  );
}

interface EmptyStateProps {
  readonly search: string;
}

function EmptyState({ search }: EmptyStateProps): ReactElement {
  return (
    <div
      data-testid="products-empty"
      style={{ padding: '2rem', textAlign: 'center', color: '#666' }}
    >
      {search.trim().length > 0
        ? `No products match "${search}".`
        : 'No products yet.'}
    </div>
  );
}
