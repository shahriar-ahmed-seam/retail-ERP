/**
 * Audit log viewer page (Phase 12, task 12.1).
 *
 * Admin-only browser over the `audit_logs` table. The page wires the
 * shared `<VirtualizedTable>` against `audit:list` so the cursor
 * pagination, debounced search, and totals strip ride on the same
 * machinery as every other list view in the app (Req 16.1, 16.3,
 * 16.5).
 *
 * Render contract:
 *
 *   - Filter bar (Req 13.1–13.4):
 *       - `actionType` select with the canonical action types from
 *         `AuditActionType`. The empty option ("All actions")
 *         clears the filter and the table re-mounts a fresh first
 *         page.
 *       - `userId` text input. Forwarded as an exact-match filter
 *         against the indexed `userId` column. Debounced ~250 ms
 *         locally so a flurry of keystrokes does not flap the table
 *         reset.
 *       - `dateFrom` / `dateTo` `<input type="date">` controls.
 *         Empty values are treated as "no bound" (the filter
 *         compiler in `audit.service` substitutes a sentinel so
 *         either side may be omitted).
 *
 *   - Each row shows timestamp, action type, entity type/id, the
 *     acting user (resolved to a username server-side), and a
 *     compact before/after summary. Detail rendering for the
 *     before/after JSON snapshots is intentionally minimal — full
 *     diff rendering is out of scope for V1.
 *
 *   - Table is virtualized via `<VirtualizedTable>` with
 *     `withCount`, so the totals strip shows "Showing N of M"
 *     once the count completes (Req 16.1, 16.5).
 *
 * Role gating (Req 8.2): the audit log is an Admin-only audit
 * tool. Cashiers see a permission-denied surface; the matrix
 * (`src/main/permission/matrix.ts`) also denies the channel
 * server-side and writes an `rbac.deny` audit row before the
 * handler runs.
 *
 * Validates: Requirements 13.1, 13.2, 13.3, 13.4, 16.1, 16.5, 8.2.
 */

// TODO(13.1): mount via role-aware shell
import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';

import { VirtualizedTable } from '@renderer/components/VirtualizedTable';
import { useAuth } from '@renderer/lib/auth-context';

import type {
  AuditActionType,
  AuditFilter,
  AuditLogDTO,
} from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Debounce window for the userId input. Mirrors `<VirtualizedTable>`'s
 *  default search debounce (250 ms) so the filter envelope settles on
 *  the same cadence as the table's own search-debounce path. */
const FILTER_DEBOUNCE_MS = 250;

/** Page size sent to `audit:list`. Server-side default is 50. */
const PAGE_SIZE = 50;

/** Per-row height in CSS pixels. Matches the grid header below. */
const ROW_HEIGHT = 56;

/** Visible-window height for the virtualized list. */
const TABLE_HEIGHT = 560;

/** Grid column template shared by header + rows.
 *  Columns: timestamp · actionType · entity · user · summary. */
const ROW_GRID_COLUMNS = '12rem 10rem 16rem 10rem 1fr';

/**
 * The canonical action-type discriminators surfaced by the renderer
 * filter dropdown. Mirrors the closed `AuditActionType` union from
 * `src/shared/dto/audit-log.ts`. Adding a new action type to that
 * union should also surface here so admins can filter on it.
 */
const ACTION_TYPE_OPTIONS: readonly {
  readonly value: AuditActionType;
  readonly label: string;
}[] = [
  { value: 'price.change', label: 'Price change' },
  { value: 'role.change', label: 'Role change' },
  { value: 'stock.adjust', label: 'Stock adjustment' },
  { value: 'rbac.deny', label: 'RBAC denial' },
  { value: 'user.create', label: 'User create' },
  { value: 'user.update', label: 'User update' },
  { value: 'settings.update', label: 'Settings update' },
  { value: 'backup.restore', label: 'Backup restore' },
];

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

export function AuditLogPage(): ReactElement {
  const { session } = useAuth();

  if (session === null) {
    return <PermissionDenied reason="signin" />;
  }
  if (session.role !== 'Admin') {
    return <PermissionDenied reason="admin-only" />;
  }

  return <AuditLogPageInner />;
}

function PermissionDenied({
  reason,
}: {
  readonly reason: 'signin' | 'admin-only';
}): ReactElement {
  return (
    <main
      role="alert"
      data-testid="audit-permission-denied"
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
        {reason === 'signin'
          ? 'You must be signed in to view the audit log.'
          : 'The audit log is an Admin-only surface. Sign in as an administrator to continue.'}
      </p>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function AuditLogPageInner(): ReactElement {
  // Filter inputs (live, pre-debounce).
  const [actionType, setActionType] = useState<AuditActionType | ''>('');
  const [userIdInput, setUserIdInput] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Debounced mirror of the userId input. Forwarded into the filter
  // envelope so the server-side prefix LIKE only fires once per
  // stable keystroke sequence.
  const [debouncedUserId, setDebouncedUserId] = useState('');
  useEffect(() => {
    if (userIdInput === debouncedUserId) return undefined;
    const handle = setTimeout(() => {
      setDebouncedUserId(userIdInput);
    }, FILTER_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [userIdInput, debouncedUserId]);

  // Compose the filter envelope. Empty fields are dropped so the
  // matching server-side filter compiler treats them as absent
  // rather than as "match empty string".
  const filter = useMemo<AuditFilter | undefined>(() => {
    const f: {
      actionType?: AuditActionType;
      userId?: string;
      dateFrom?: string;
      dateTo?: string;
    } = {};
    if (actionType !== '') f.actionType = actionType;
    const trimmedUserId = debouncedUserId.trim();
    if (trimmedUserId.length > 0) f.userId = trimmedUserId;
    if (dateFrom !== '') {
      // `<input type="date">` emits `YYYY-MM-DD`; widen to a
      // start-of-day ISO string so the server's range predicate
      // anchors to the start of the selected day.
      f.dateFrom = `${dateFrom}T00:00:00.000Z`;
    }
    if (dateTo !== '') {
      // End-of-day so the inclusive `lte` predicate captures
      // every row stamped that day.
      f.dateTo = `${dateTo}T23:59:59.999Z`;
    }
    return Object.keys(f).length > 0 ? f : undefined;
  }, [actionType, debouncedUserId, dateFrom, dateTo]);

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '80rem',
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
        <h1 style={{ margin: 0 }}>Audit log</h1>
      </header>

      <section
        aria-label="Audit filters"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'flex-end',
          marginBottom: '1rem',
        }}
      >
        <label htmlFor="audit-action-type" style={{ flex: '1 1 12rem' }}>
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            Action type
          </span>
          <select
            id="audit-action-type"
            data-testid="audit-action-type"
            value={actionType}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const v = e.target.value;
              setActionType(v === '' ? '' : (v as AuditActionType));
            }}
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
          >
            <option value="">All actions</option>
            {ACTION_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label htmlFor="audit-user-id" style={{ flex: '1 1 12rem' }}>
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            User ID
          </span>
          <input
            id="audit-user-id"
            data-testid="audit-user-id"
            type="search"
            value={userIdInput}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setUserIdInput(e.target.value);
            }}
            placeholder="exact match"
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
          />
        </label>

        <label htmlFor="audit-date-from" style={{ flex: '0 0 10rem' }}>
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            From
          </span>
          <input
            id="audit-date-from"
            data-testid="audit-date-from"
            type="date"
            value={dateFrom}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setDateFrom(e.target.value);
            }}
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
          />
        </label>

        <label htmlFor="audit-date-to" style={{ flex: '0 0 10rem' }}>
          <span
            style={{
              display: 'block',
              fontSize: '0.875rem',
              marginBottom: '0.125rem',
            }}
          >
            To
          </span>
          <input
            id="audit-date-to"
            data-testid="audit-date-to"
            type="date"
            value={dateTo}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setDateTo(e.target.value);
            }}
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
          />
        </label>
      </section>

      <AuditTableHeader />

      <VirtualizedTable
        channel="audit:list"
        pageSize={PAGE_SIZE}
        withCount
        {...(filter !== undefined ? { filter } : {})}
        rowHeight={ROW_HEIGHT}
        height={TABLE_HEIGHT}
        renderRow={renderAuditRow}
        emptyState={<EmptyState />}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Static column header
// ---------------------------------------------------------------------------

function AuditTableHeader(): ReactElement {
  return (
    <div
      role="row"
      data-testid="audit-table-header"
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
      <span>Action</span>
      <span>Entity</span>
      <span>User</span>
      <span>Summary</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit row
// ---------------------------------------------------------------------------

/**
 * Module-level row renderer so the function identity is stable across
 * renders — `<VirtualizedTable>` re-mounts rows whenever `renderRow`
 * changes identity, and a per-render closure would defeat
 * virtualization's bounded DOM mount count (Req 16.5).
 */
function renderAuditRow(row: AuditLogDTO): ReactElement {
  return <AuditRow row={row} />;
}

interface AuditRowProps {
  readonly row: AuditLogDTO;
}

function AuditRow({ row }: AuditRowProps): ReactElement {
  return (
    <div
      role="row"
      data-testid={`audit-row-${row.id}`}
      data-audit-id={row.id}
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
      <span style={{ color: '#555' }} title={row.timestamp}>
        {formatTimestamp(row.timestamp)}
      </span>
      <span>
        <code style={{ fontFamily: 'ui-monospace, monospace' }}>
          {row.actionType}
        </code>
      </span>
      <span style={{ color: '#555' }} title={`${row.entityType}:${row.entityId}`}>
        {row.entityType}:{truncate(row.entityId, 24)}
      </span>
      <span style={{ color: '#555' }}>
        {row.userName ?? (row.userId === null ? 'system' : truncate(row.userId, 12))}
      </span>
      <span style={{ color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {summarize(row)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState(): ReactElement {
  return (
    <div
      data-testid="audit-empty"
      style={{ padding: '2rem', textAlign: 'center', color: '#666' }}
    >
      No audit log entries match the current filters.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Build a compact one-line summary of a row's before/after snapshots.
 * Renders a generic `prev → next` view for snapshots that look like
 * `{ key: value }` objects, falls back to a plain JSON stringify
 * otherwise. Detail rendering is intentionally minimal here — a
 * dedicated diff viewer is out of scope for V1.
 */
function summarize(row: AuditLogDTO): string {
  const previous = compactJson(row.previous);
  const next = compactJson(row.next);
  if (previous === null && next === null) return '';
  if (previous === null) return `→ ${next ?? ''}`;
  if (next === null) return `${previous} →`;
  return `${previous} → ${next}`;
}

function compactJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return truncate(json ?? '', 80);
  } catch {
    return null;
  }
}
