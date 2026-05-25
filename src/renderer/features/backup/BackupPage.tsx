/**
 * Backup management page (Phase 11, task 11.7).
 *
 * Admin-only entry point under settings for inspecting, creating,
 * and restoring snapshots of the live database. Uses the three
 * `backup:*` IPC channels:
 *
 *   - `backup:list`    Lists every `shop-YYYY-MM-DD.db` file under
 *                      the user-data backups directory. The page
 *                      loads the list on mount and refreshes it
 *                      after every action.
 *
 *   - `backup:now`     Triggers a manual `VACUUM INTO` snapshot on
 *                      demand. The button reports success/failure
 *                      inline and refreshes the list so the new
 *                      file appears at the top.
 *
 *   - `backup:restore` Per-row Restore button. On click, surfaces
 *                      a confirmation modal naming the snapshot;
 *                      on confirm, fires the IPC and reports the
 *                      replay telemetry inline. Restore is
 *                      destructive (overwrites shop.db) so the
 *                      confirmation is mandatory.
 *
 * Role gating (Req 8.2): only the `Admin` role reaches the page.
 * Cashiers — and unauthenticated renderers — see a permission-
 * denied surface instead. Defence-in-depth: the IPC matrix denies
 * `backup:*` for cashiers (writes an `rbac.deny` audit row,
 * Req 8.4), but rendering the page for a role that cannot save it
 * would be a confusing UX.
 *
 * Validates: Requirements 8.2, 10.1, 10.2.
 */

import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
} from 'react';

import { useApi } from '@renderer/lib/api';
import { useAuth } from '@renderer/lib/auth-context';

import type { ErrorEnvelope } from '@shared/result';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SnapshotRow {
  readonly filename: string;
  readonly path: string;
  readonly takenAt: string;
  readonly sizeBytes: number;
}

interface RestoreNotice {
  readonly path: string;
  readonly batchCount: number;
  readonly appliedCount: number;
}

// ---------------------------------------------------------------------------
// Top-level component (role gate)
// ---------------------------------------------------------------------------

/**
 * Public entry point. Splits the role gate from the page body so
 * the body's hooks don't violate React's hooks-order invariant
 * across the gated branch.
 */
export function BackupPage(): ReactElement {
  const { session } = useAuth();
  if (session?.role !== 'Admin') {
    return <PermissionDenied />;
  }
  return <BackupPageInner />;
}

// ---------------------------------------------------------------------------
// Permission-denied fallback
// ---------------------------------------------------------------------------

function PermissionDenied(): ReactElement {
  return (
    <main
      role="alert"
      data-testid="backup-permission-denied"
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
      <p>Backup management is restricted to the Admin role.</p>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a byte count into a human-friendly string (KB/MB).
 * Snapshots are typically tens of MB; we keep two decimal places
 * so the operator can compare same-day sizes precisely.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format an ISO timestamp into a locale-friendly string. Falls
 * back to the raw string when parsing fails.
 */
function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

function BackupPageInner(): ReactElement {
  const api = useApi();

  // ----- List state ------------------------------------------------------
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<ErrorEnvelope | null>(null);
  const [snapshots, setSnapshots] = useState<readonly SnapshotRow[]>([]);

  // ----- Backup-now state ------------------------------------------------
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupError, setBackupError] = useState<ErrorEnvelope | null>(null);
  const [backupNotice, setBackupNotice] = useState<{ path: string } | null>(null);

  // ----- Restore state ---------------------------------------------------
  const [pendingRestore, setPendingRestore] = useState<SnapshotRow | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<ErrorEnvelope | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<RestoreNotice | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setLoadError(null);
    const result = await api['backup:list']();
    if (!result.ok) {
      setLoadError(result.error);
      setSnapshots([]);
      setIsLoading(false);
      return;
    }
    setSnapshots(result.value.rows);
    setIsLoading(false);
  }, [api]);

  // ----- Initial load ----------------------------------------------------
  useEffect(() => {
    void reload();
  }, [reload]);

  // ----- Backup now ------------------------------------------------------
  const handleBackupNow = useCallback((): void => {
    if (isBackingUp) return;

    setIsBackingUp(true);
    setBackupError(null);
    setBackupNotice(null);

    void (async () => {
      try {
        const result = await api['backup:now']();
        if (!result.ok) {
          setBackupError(result.error);
          return;
        }
        setBackupNotice({ path: result.value.path });
        await reload();
      } finally {
        setIsBackingUp(false);
      }
    })();
  }, [api, isBackingUp, reload]);

  // ----- Restore (with confirmation) -------------------------------------
  const beginRestore = useCallback((row: SnapshotRow): void => {
    setPendingRestore(row);
    setRestoreError(null);
    setRestoreNotice(null);
  }, []);

  const cancelRestore = useCallback((): void => {
    setPendingRestore(null);
  }, []);

  const confirmRestore = useCallback((): void => {
    if (pendingRestore === null || isRestoring) return;
    const row = pendingRestore;

    setIsRestoring(true);
    setRestoreError(null);

    void (async () => {
      try {
        const result = await api['backup:restore']({ path: row.path });
        if (!result.ok) {
          setRestoreError(result.error);
          return;
        }
        setRestoreNotice({
          path: row.path,
          batchCount: result.value.replayed.batchCount,
          appliedCount: result.value.replayed.appliedCount,
        });
        setPendingRestore(null);
        await reload();
      } finally {
        setIsRestoring(false);
      }
    })();
  }, [api, isRestoring, pendingRestore, reload]);

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '1.5rem',
        maxWidth: '48rem',
        margin: '0 auto',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>Backups</h1>
      <p style={{ marginBottom: '1.5rem', color: '#555' }}>
        Snapshots of the live database. Daily snapshots are taken automatically;
        use Backup now to take an on-demand snapshot. Restoring overwrites the
        current database and replays the journal forward — only restore when
        recovery is needed.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button
          type="button"
          disabled={isBackingUp}
          onClick={handleBackupNow}
          data-testid="backup-now"
          style={{ padding: '0.625rem 1.25rem' }}
        >
          {isBackingUp ? 'Backing up…' : 'Backup now'}
        </button>
        <button
          type="button"
          onClick={() => {
            void reload();
          }}
          disabled={isLoading}
          data-testid="backup-refresh"
          style={{ padding: '0.625rem 1.25rem' }}
        >
          {isLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Backup-now status */}
      {backupError !== null ? (
        <Banner kind="error" testId="backup-now-error">
          <strong>Backup failed ({backupError.code})</strong>
          <div>{backupError.message}</div>
        </Banner>
      ) : null}
      {backupNotice !== null ? (
        <Banner kind="success" testId="backup-now-success">
          <strong>Snapshot created</strong>
          <div>
            Saved to <code>{backupNotice.path}</code>
          </div>
        </Banner>
      ) : null}

      {/* Restore status */}
      {restoreError !== null ? (
        <Banner kind="error" testId="backup-restore-error">
          <strong>Restore failed ({restoreError.code})</strong>
          <div>{restoreError.message}</div>
        </Banner>
      ) : null}
      {restoreNotice !== null ? (
        <Banner kind="success" testId="backup-restore-success">
          <strong>Restore complete</strong>
          <div>
            Replayed {restoreNotice.appliedCount} entries across{' '}
            {restoreNotice.batchCount} batches.
          </div>
        </Banner>
      ) : null}

      {/* List */}
      {loadError !== null ? (
        <Banner kind="error" testId="backup-list-error">
          <strong>Could not list snapshots ({loadError.code})</strong>
          <div>{loadError.message}</div>
        </Banner>
      ) : null}

      {isLoading ? (
        <p data-testid="backup-list-loading">Loading snapshots…</p>
      ) : snapshots.length === 0 ? (
        <p data-testid="backup-list-empty" style={{ color: '#555' }}>
          No snapshots yet. Click Backup now to create the first one.
        </p>
      ) : (
        <table
          data-testid="backup-list"
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            border: '1px solid #ddd',
          }}
        >
          <thead>
            <tr style={{ background: '#f5f5f5', textAlign: 'left' }}>
              <th style={{ padding: '0.5rem' }}>File</th>
              <th style={{ padding: '0.5rem' }}>Taken at</th>
              <th style={{ padding: '0.5rem' }}>Size</th>
              <th style={{ padding: '0.5rem' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((row) => (
              <tr
                key={row.path}
                data-testid="backup-row"
                style={{ borderTop: '1px solid #eee' }}
              >
                <td style={{ padding: '0.5rem' }}>
                  <code>{row.filename}</code>
                </td>
                <td style={{ padding: '0.5rem' }}>{formatTimestamp(row.takenAt)}</td>
                <td style={{ padding: '0.5rem' }}>{formatSize(row.sizeBytes)}</td>
                <td style={{ padding: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => {
                      beginRestore(row);
                    }}
                    data-testid="backup-restore"
                    style={{ padding: '0.375rem 0.75rem' }}
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Confirmation modal */}
      {pendingRestore !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="backup-confirm-title"
          data-testid="backup-restore-confirm"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 6,
              padding: '1.5rem',
              maxWidth: '32rem',
              width: '100%',
              boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
            }}
          >
            <h2 id="backup-confirm-title" style={{ marginTop: 0 }}>
              Restore from {pendingRestore.filename}?
            </h2>
            <p style={{ color: '#555' }}>
              This will overwrite the current database with the selected
              snapshot, then replay the journal forward. Any work performed
              after this snapshot was taken will be re-applied automatically;
              work that was never journaled will be lost. This action cannot
              be undone.
            </p>
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                onClick={cancelRestore}
                disabled={isRestoring}
                data-testid="backup-restore-cancel"
                style={{ padding: '0.625rem 1.25rem' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRestore}
                disabled={isRestoring}
                data-testid="backup-restore-confirm-btn"
                style={{
                  padding: '0.625rem 1.25rem',
                  background: '#c33',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                }}
              >
                {isRestoring ? 'Restoring…' : 'Restore now'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Banner — small inline status component
// ---------------------------------------------------------------------------

interface BannerProps {
  readonly kind: 'success' | 'error';
  readonly testId: string;
  readonly children: React.ReactNode;
}

function Banner({ kind, testId, children }: BannerProps): ReactElement {
  const isError = kind === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? undefined : 'polite'}
      data-testid={testId}
      style={{
        marginBottom: '1rem',
        padding: '0.75rem',
        border: `1px solid ${isError ? '#c33' : '#2a8'}`,
        color: isError ? '#c33' : '#1a6',
        background: isError ? '#fff5f5' : '#f3fff7',
        borderRadius: 4,
      }}
    >
      {children}
    </div>
  );
}
