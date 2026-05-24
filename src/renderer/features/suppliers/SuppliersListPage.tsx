/**
 * Suppliers list page (task 6.1, Phase 6).
 *
 * Single-screen supplier directory browser. Drives the shared
 * `<VirtualizedTable>` against `suppliers:list` so the search UI
 * layered on top sits over the same paginated machinery used by
 * every other list view in the app (Req 16.1, 16.3, 16.5).
 *
 * Render contract:
 *   - Search input. The hook owns the 250 ms debounce — we forward
 *     keystrokes directly without local debouncing.
 *   - "New supplier" button. Admin only. The IPC matrix already
 *     denies `suppliers:upsert` for cashiers, but the channel itself
 *     is denied for cashiers too — they should never see the page.
 *     The role gate at the top of the component covers that.
 *   - Each row shows name, phone, address. Clicking a row opens the
 *     supplier detail page; clicking the action column's edit
 *     affordance opens the form.
 *
 * Navigation between list, form, and detail is local component
 * state. Once the route tree (task 13.1) lands, the create / edit /
 * detail / cancel branches become `navigate(...)`-style calls and
 * this page collapses to a single "list" responsibility.
 *
 * Validates: Requirements 6.1, 6.2, 8.2, 16.1, 16.3, 16.5.
 */

import {
  useCallback,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';

import { VirtualizedTable } from '@renderer/components/VirtualizedTable';
import { useAuth } from '@renderer/lib/auth-context';

import { SupplierDetailPage } from './SupplierDetailPage';
import { SupplierFormPage } from './SupplierFormPage';

import type { SupplierDTO } from '@shared/dto/index';

// ---------------------------------------------------------------------------
// View-state types
// ---------------------------------------------------------------------------

/**
 * Local view-state shape. The list page can be in one of four modes:
 *   - `'list'`         — table is the active surface.
 *   - `'create'`       — form is mounted with no `supplier` prop.
 *   - `'edit'`         — form is mounted with the row clicked in the list.
 *   - `'detail'`       — detail page is mounted with the row clicked.
 *
 * State lives here (rather than the form) so a successful submit can
 * snap back to `'list'` and the table re-mounts a fresh first page —
 * which makes the freshly-created / edited row visible without a
 * dedicated cache-invalidation channel.
 */
type ViewMode =
  | { readonly kind: 'list' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly supplier: SupplierDTO }
  | { readonly kind: 'detail'; readonly supplierId: string };

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

export function SuppliersListPage(): ReactElement {
  const { session } = useAuth();

  if (session?.role !== 'Admin') {
    return <PermissionDenied />;
  }

  return <SuppliersListPageInner />;
}

function PermissionDenied(): ReactElement {
  return (
    <main
      role="alert"
      data-testid="suppliers-permission-denied"
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
        Supplier management is restricted to the Admin role. Please sign
        in as an administrator to continue.
      </p>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function SuppliersListPageInner(): ReactElement {
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>({ kind: 'list' });

  // ----- Mode-switch handlers -------------------------------------------
  const openCreate = useCallback((): void => {
    setView({ kind: 'create' });
  }, []);

  const openEdit = useCallback((supplier: SupplierDTO): void => {
    setView({ kind: 'edit', supplier });
  }, []);

  const openDetail = useCallback((supplier: SupplierDTO): void => {
    setView({ kind: 'detail', supplierId: supplier.id });
  }, []);

  const closeForm = useCallback((): void => {
    setView({ kind: 'list' });
  }, []);

  // ----- Row renderer ----------------------------------------------------
  // Closure captures `openDetail` and `openEdit`; `useCallback` keeps
  // the function identity stable so the virtualized list does not
  // re-render every row on unrelated parent updates. Declared BEFORE
  // the form-branch early returns so React's hooks-order invariant
  // holds.
  const renderRow = useCallback(
    (row: SupplierDTO): ReactElement => (
      <SupplierRow row={row} onOpen={openDetail} onEdit={openEdit} />
    ),
    [openDetail, openEdit],
  );

  // ----- Branched modes --------------------------------------------------
  if (view.kind === 'create') {
    return <SupplierFormPage onClose={closeForm} />;
  }
  if (view.kind === 'edit') {
    return <SupplierFormPage supplier={view.supplier} onClose={closeForm} />;
  }
  if (view.kind === 'detail') {
    return (
      <SupplierDetailPage
        supplierId={view.supplierId}
        onClose={closeForm}
        onEdit={openEdit}
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
        <h1 style={{ margin: 0 }}>Suppliers</h1>
        <button
          type="button"
          onClick={openCreate}
          data-testid="suppliers-new-button"
          style={{ padding: '0.5rem 1rem' }}
        >
          New supplier
        </button>
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
        <label htmlFor="suppliers-search" style={{ flex: '1 1 16rem' }}>
          <span style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.125rem' }}>
            Search
          </span>
          <input
            id="suppliers-search"
            type="search"
            value={search}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setSearch(e.target.value);
            }}
            placeholder="Name"
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
          />
        </label>
      </section>

      <SuppliersTableHeader />

      <VirtualizedTable
        channel="suppliers:list"
        pageSize={50}
        withCount
        search={search}
        rowHeight={56}
        height={560}
        renderRow={renderRow}
        emptyState={<EmptyState search={search} />}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Static column header
// ---------------------------------------------------------------------------

function SuppliersTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="suppliers-table-header"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 12rem 1fr 6rem',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        fontWeight: 600,
        borderBottom: '1px solid #ddd',
        background: '#f7f7f7',
      }}
    >
      <span>Name</span>
      <span>Phone</span>
      <span>Address</span>
      <span style={{ textAlign: 'right' }}>Actions</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplier row
// ---------------------------------------------------------------------------

interface SupplierRowProps {
  readonly row: SupplierDTO;
  readonly onOpen: (supplier: SupplierDTO) => void;
  readonly onEdit: (supplier: SupplierDTO) => void;
}

function SupplierRow({ row, onOpen, onEdit }: SupplierRowProps): ReactElement {
  const handleOpen = (): void => {
    onOpen(row);
  };
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(row);
    }
  };
  const handleEdit = (e: React.MouseEvent<HTMLButtonElement>): void => {
    // Stop propagation so the row click does not also fire — the
    // edit button is a focused affordance inside a clickable row.
    e.stopPropagation();
    onEdit(row);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={handleKey}
      data-testid={`suppliers-row-${row.id}`}
      data-supplier-id={row.id}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 12rem 1fr 6rem',
        gap: '0.5rem',
        padding: '0.5rem 0.75rem',
        cursor: 'pointer',
        borderBottom: '1px solid #eee',
        alignItems: 'center',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <span>{row.name}</span>
      <span style={{ color: '#555' }}>{row.phone ?? '—'}</span>
      <span style={{ color: '#555' }}>{row.address ?? '—'}</span>
      <span style={{ textAlign: 'right' }}>
        <button
          type="button"
          onClick={handleEdit}
          data-testid={`suppliers-row-edit-${row.id}`}
          style={{ padding: '0.25rem 0.5rem' }}
        >
          Edit
        </button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ search }: { readonly search: string }): ReactElement {
  return (
    <div
      data-testid="suppliers-empty"
      style={{ padding: '2rem', textAlign: 'center', color: '#666' }}
    >
      {search.trim().length > 0
        ? `No suppliers match "${search}".`
        : 'No suppliers yet.'}
    </div>
  );
}
