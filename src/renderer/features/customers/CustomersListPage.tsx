/**
 * Customers list page (task 9.2, Phase 9).
 *
 * Single-screen customer directory browser. Drives the shared
 * `<VirtualizedTable>` against `customers:list` so the search UI
 * layered on top sits over the same paginated machinery used by
 * every other list view in the app (Req 16.1, 16.3, 16.5).
 *
 * Render contract:
 *   - Phone-prefix search input. Debounced ~300 ms locally so the
 *     forwarded `filter.phonePrefix` does not flap mid-keystroke and
 *     so the table's reset detection only fires on stable values
 *     (Req 16.3 — `Customer.phone` is the indexed prefix-search column).
 *   - "New customer" button. Admin only. Cashiers see the directory
 *     read-only — the IPC matrix authorizes `customers:upsert` for
 *     both roles (so cashiers can create walk-in records mid-checkout
 *     per Req 7.2), but the dedicated management form is gated to
 *     Admin per task 9.2.
 *   - Each row shows name, phone, created-at, and a per-row action
 *     column. Clicking a row opens the customer detail page; clicking
 *     the action column's edit affordance opens the form (Admin only).
 *
 * Role gating (Req 8.3): Admin and Cashier may both browse the list.
 * Unauthenticated renderers see a permission-denied surface.
 *
 * Navigation between list, form, and detail is local component
 * state. Once the route tree (task 13.1) lands, the create / edit /
 * detail / cancel branches become `navigate(...)`-style calls and
 * this page collapses to a single "list" responsibility.
 *
 * Validates: Requirements 7.1, 7.3, 8.3, 16.1, 16.3, 16.5.
 */

import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';

import { VirtualizedTable } from '@renderer/components/VirtualizedTable';
import { useAuth } from '@renderer/lib/auth-context';

import { CustomerDetailPage } from './CustomerDetailPage';
import { CustomerFormPage } from './CustomerFormPage';

import type { CustomerDTO, CustomerFilter } from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Debounce window for the phone-prefix input. Mirrors AdjustPage. */
const SEARCH_DEBOUNCE_MS = 300;

/** Page size sent to `customers:list`. Server-side default is 50. */
const PAGE_SIZE = 50;

/** Per-row height in CSS pixels. Matches the grid header below. */
const ROW_HEIGHT = 56;

/** Visible-window height for the virtualized list. */
const TABLE_HEIGHT = 560;

/** Grid column template shared by header + rows. */
const ROW_GRID_COLUMNS = '1fr 12rem 12rem 6rem';

// ---------------------------------------------------------------------------
// View-state types
// ---------------------------------------------------------------------------

/**
 * Local view-state shape. The list page can be in one of four modes:
 *   - `'list'`         — table is the active surface.
 *   - `'create'`       — form is mounted with no `customer` prop.
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
  | { readonly kind: 'edit'; readonly customer: CustomerDTO }
  | { readonly kind: 'detail'; readonly customerId: string };

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

export function CustomersListPage(): ReactElement {
  const { session } = useAuth();

  if (session === null) {
    return <PermissionDenied />;
  }

  return <CustomersListPageInner />;
}

function PermissionDenied(): ReactElement {
  return (
    <main
      role="alert"
      data-testid="customers-permission-denied"
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
        You must be signed in to view the customer directory. Please sign
        in to continue.
      </p>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function CustomersListPageInner(): ReactElement {
  const { session } = useAuth();
  const isAdmin = session?.role === 'Admin';

  const [phoneInput, setPhoneInput] = useState('');
  const [debouncedPhone, setDebouncedPhone] = useState('');
  const [view, setView] = useState<ViewMode>({ kind: 'list' });

  // Debounce the phone-prefix input. The filter envelope sent to
  // `customers:list` carries the trimmed/debounced value so the
  // server-side prefix LIKE only fires once per stable keystroke
  // sequence (Req 16.3).
  useEffect(() => {
    if (phoneInput === debouncedPhone) return undefined;
    const handle = setTimeout(() => {
      setDebouncedPhone(phoneInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [phoneInput, debouncedPhone]);

  // ----- Mode-switch handlers -------------------------------------------
  const openCreate = useCallback((): void => {
    setView({ kind: 'create' });
  }, []);

  const openEdit = useCallback((customer: CustomerDTO): void => {
    setView({ kind: 'edit', customer });
  }, []);

  const openDetail = useCallback((customer: CustomerDTO): void => {
    setView({ kind: 'detail', customerId: customer.id });
  }, []);

  const closeForm = useCallback((): void => {
    setView({ kind: 'list' });
  }, []);

  // ----- Row renderer ----------------------------------------------------
  // Closure captures `openDetail`, `openEdit`, and `isAdmin`;
  // `useCallback` keeps the function identity stable so the
  // virtualized list does not re-render every row on unrelated parent
  // updates. Declared BEFORE the form-branch early returns so React's
  // hooks-order invariant holds.
  const renderRow = useCallback(
    (row: CustomerDTO): ReactElement => (
      <CustomerRow
        row={row}
        canEdit={isAdmin}
        onOpen={openDetail}
        onEdit={openEdit}
      />
    ),
    [isAdmin, openDetail, openEdit],
  );

  // ----- Branched modes --------------------------------------------------
  if (view.kind === 'create') {
    return <CustomerFormPage onClose={closeForm} />;
  }
  if (view.kind === 'edit') {
    return <CustomerFormPage customer={view.customer} onClose={closeForm} />;
  }
  if (view.kind === 'detail') {
    return (
      <CustomerDetailPage
        customerId={view.customerId}
        onClose={closeForm}
        {...(isAdmin ? { onEdit: openEdit } : {})}
      />
    );
  }

  // Build the filter envelope inline so undefined fields are absent
  // rather than explicitly `undefined` (matches `exactOptionalPropertyTypes`).
  // The trimmed prefix gates the filter as a whole — sending
  // `{ phonePrefix: '' }` would match nothing useful, so we omit the
  // whole object until the user has typed something.
  const trimmedPhone = debouncedPhone.trim();
  const filter: CustomerFilter | undefined =
    trimmedPhone.length > 0 ? { phonePrefix: trimmedPhone } : undefined;

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
        <h1 style={{ margin: 0 }}>Customers</h1>
        {isAdmin ? (
          <button
            type="button"
            onClick={openCreate}
            data-testid="customers-new-button"
            style={{ padding: '0.5rem 1rem' }}
          >
            New customer
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
        <label htmlFor="customers-phone-search" style={{ flex: '1 1 16rem' }}>
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            Phone prefix
          </span>
          <input
            id="customers-phone-search"
            data-testid="customers-phone-search"
            type="search"
            value={phoneInput}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setPhoneInput(e.target.value);
            }}
            placeholder="555..."
            inputMode="tel"
            style={{
              width: '100%',
              padding: '0.5rem',
              boxSizing: 'border-box',
            }}
          />
        </label>
      </section>

      <CustomersTableHeader />

      <VirtualizedTable
        channel="customers:list"
        pageSize={PAGE_SIZE}
        withCount
        {...(filter !== undefined ? { filter } : {})}
        rowHeight={ROW_HEIGHT}
        height={TABLE_HEIGHT}
        renderRow={renderRow}
        emptyState={<EmptyState search={trimmedPhone} />}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Static column header
// ---------------------------------------------------------------------------

function CustomersTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="customers-table-header"
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
      <span>Name</span>
      <span>Phone</span>
      <span>Created</span>
      <span style={{ textAlign: 'right' }}>Actions</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer row
// ---------------------------------------------------------------------------

interface CustomerRowProps {
  readonly row: CustomerDTO;
  readonly canEdit: boolean;
  readonly onOpen: (customer: CustomerDTO) => void;
  readonly onEdit: (customer: CustomerDTO) => void;
}

function CustomerRow({
  row,
  canEdit,
  onOpen,
  onEdit,
}: CustomerRowProps): ReactElement {
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
      data-testid={`customers-row-${row.id}`}
      data-customer-id={row.id}
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
      <span>{row.name}</span>
      <span style={{ color: '#555' }}>{row.phone ?? '—'}</span>
      <span style={{ color: '#555' }} title={row.createdAt}>
        {formatDate(row.createdAt)}
      </span>
      <span style={{ textAlign: 'right' }}>
        {canEdit ? (
          <button
            type="button"
            onClick={handleEdit}
            data-testid={`customers-row-edit-${row.id}`}
            style={{ padding: '0.25rem 0.5rem' }}
          >
            Edit
          </button>
        ) : (
          <span style={{ color: '#999', fontSize: '0.875rem' }}>—</span>
        )}
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
      data-testid="customers-empty"
      style={{ padding: '2rem', textAlign: 'center', color: '#666' }}
    >
      {search.length > 0
        ? `No customers match phone prefix "${search}".`
        : 'No customers yet.'}
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
