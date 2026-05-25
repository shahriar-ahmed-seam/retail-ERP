/**
 * Unit tests for `<BackupPage />` (Phase 11, task 11.7).
 *
 * Covers:
 *   - Role gate: cashiers see the permission-denied panel.
 *   - List load: snapshots render in a table with filename, takenAt,
 *     and size columns.
 *   - Backup now: triggers `backup:now` and refreshes the list.
 *   - Restore confirmation modal: cancel does not call IPC; confirm
 *     calls `backup:restore` and renders the replay telemetry.
 *   - Error envelopes surface inline, not via toast.
 *
 * Validates: Requirements 8.2, 10.1, 10.2.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackupPage } from '@renderer/features/backup/BackupPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Ok, Err } from '@shared/result';

import type { Api } from '@shared/ipc-contract';
import type { Result } from '@shared/result';

// ---------------------------------------------------------------------------
// API stub on window.api
// ---------------------------------------------------------------------------

interface ApiStubState {
  list: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
}

let apiState: ApiStubState;

function buildApiStub(): Api {
  // Build a typed proxy that returns the corresponding mock for the
  // three channels we exercise. Other channels return a generic
  // "not implemented" Err so a stray call surfaces clearly.
  const stub = {
    'backup:list': (): Promise<Result<unknown>> =>
      apiState.list() as Promise<Result<unknown>>,
    'backup:now': (): Promise<Result<unknown>> =>
      apiState.now() as Promise<Result<unknown>>,
    'backup:restore': (req: { path: string }): Promise<Result<unknown>> =>
      apiState.restore(req) as Promise<Result<unknown>>,
  } as unknown as Api;
  return stub;
}

beforeEach(() => {
  apiState = {
    list: vi.fn(),
    now: vi.fn(),
    restore: vi.fn(),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: buildApiStub(),
  });
});

afterEach(() => {
  // Defensively clear any leftover state.
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithAdmin(): void {
  render(
    <AuthProvider
      initialSession={{
        sessionId: 's1',
        userId: 'u1',
        username: 'admin',
        role: 'Admin',
      }}
    >
      <BackupPage />
    </AuthProvider>,
  );
}

function renderWithCashier(): void {
  render(
    <AuthProvider
      initialSession={{
        sessionId: 's2',
        userId: 'u2',
        username: 'cashier',
        role: 'Cashier',
      }}
    >
      <BackupPage />
    </AuthProvider>,
  );
}

const sampleRows = [
  {
    filename: 'shop-2024-05-03.db',
    path: '/userData/backups/shop-2024-05-03.db',
    takenAt: '2024-05-03T10:00:00.000Z',
    sizeBytes: 2 * 1024 * 1024,
  },
  {
    filename: 'shop-2024-05-02.db',
    path: '/userData/backups/shop-2024-05-02.db',
    takenAt: '2024-05-02T10:00:00.000Z',
    sizeBytes: 1.5 * 1024 * 1024,
  },
] as const;

function listOk(): Result<{ rows: readonly typeof sampleRows[number][] }> {
  return Ok({ rows: sampleRows });
}

// ---------------------------------------------------------------------------
// Role gate
// ---------------------------------------------------------------------------

describe('BackupPage — role gate', () => {
  it('renders the permission-denied panel for cashiers', () => {
    renderWithCashier();
    expect(screen.getByTestId('backup-permission-denied')).toBeInTheDocument();
    expect(apiState.list).not.toHaveBeenCalled();
  });

  it('renders the permission-denied panel for unauthenticated renderers', () => {
    render(
      <AuthProvider initialSession={null}>
        <BackupPage />
      </AuthProvider>,
    );
    expect(screen.getByTestId('backup-permission-denied')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// List load
// ---------------------------------------------------------------------------

describe('BackupPage — list load', () => {
  it('loads snapshots on mount and renders one row per snapshot', async () => {
    apiState.list.mockResolvedValue(listOk());
    renderWithAdmin();

    await waitFor(() => {
      expect(screen.getByTestId('backup-list')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('backup-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('shop-2024-05-03.db')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('shop-2024-05-02.db')).toBeInTheDocument();
  });

  it('renders an empty-state message when no snapshots exist', async () => {
    apiState.list.mockResolvedValue(Ok({ rows: [] }));
    renderWithAdmin();

    await waitFor(() => {
      expect(screen.getByTestId('backup-list-empty')).toBeInTheDocument();
    });
  });

  it('surfaces a load error inline', async () => {
    apiState.list.mockResolvedValue(Err('INTERNAL', { reason: 'list_snapshots_failed' }));
    renderWithAdmin();

    await waitFor(() => {
      expect(screen.getByTestId('backup-list-error')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Backup now
// ---------------------------------------------------------------------------

describe('BackupPage — Backup now', () => {
  it('triggers backup:now, surfaces success, and refreshes the list', async () => {
    apiState.list.mockResolvedValue(Ok({ rows: [] }));
    apiState.now.mockResolvedValue(Ok({ path: '/userData/backups/shop-2024-05-04.db' }));
    renderWithAdmin();

    await waitFor(() => {
      expect(screen.getByTestId('backup-list-empty')).toBeInTheDocument();
    });

    apiState.list.mockResolvedValueOnce(
      Ok({
        rows: [
          {
            filename: 'shop-2024-05-04.db',
            path: '/userData/backups/shop-2024-05-04.db',
            takenAt: '2024-05-04T10:00:00.000Z',
            sizeBytes: 1024,
          },
        ],
      }),
    );

    fireEvent.click(screen.getByTestId('backup-now'));

    await waitFor(() => {
      expect(apiState.now).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('backup-now-success')).toBeInTheDocument();
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId('backup-row');
      expect(rows).toHaveLength(1);
    });
  });

  it('surfaces an error envelope inline when backup:now fails', async () => {
    apiState.list.mockResolvedValue(Ok({ rows: [] }));
    apiState.now.mockResolvedValue(Err('INTERNAL', { reason: 'snapshot_failed' }));
    renderWithAdmin();

    await waitFor(() => {
      expect(screen.getByTestId('backup-list-empty')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('backup-now'));
    await waitFor(() => {
      expect(screen.getByTestId('backup-now-error')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Restore (with confirmation)
// ---------------------------------------------------------------------------

describe('BackupPage — Restore with confirmation', () => {
  it('opens a confirmation modal on Restore and cancels without calling IPC', async () => {
    apiState.list.mockResolvedValue(listOk());
    renderWithAdmin();

    await waitFor(() => {
      expect(screen.getByTestId('backup-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByTestId('backup-restore')[0]!);
    expect(screen.getByTestId('backup-restore-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('backup-restore-cancel'));
    expect(screen.queryByTestId('backup-restore-confirm')).not.toBeInTheDocument();
    expect(apiState.restore).not.toHaveBeenCalled();
  });

  it('confirms restore — calls backup:restore and surfaces telemetry', async () => {
    apiState.list.mockResolvedValue(listOk());
    apiState.restore.mockResolvedValue(
      Ok({ replayed: { batchCount: 2, appliedCount: 17 } }),
    );
    renderWithAdmin();

    await waitFor(() => {
      expect(screen.getByTestId('backup-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByTestId('backup-restore')[0]!);
    fireEvent.click(screen.getByTestId('backup-restore-confirm-btn'));

    await waitFor(() => {
      expect(apiState.restore).toHaveBeenCalledWith({
        path: '/userData/backups/shop-2024-05-03.db',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('backup-restore-success')).toBeInTheDocument();
    });
    expect(screen.getByText(/Replayed 17 entries/u)).toBeInTheDocument();
    expect(screen.getByText(/across 2 batches/u)).toBeInTheDocument();
  });

  it('surfaces an error envelope inline when backup:restore fails', async () => {
    apiState.list.mockResolvedValue(listOk());
    apiState.restore.mockResolvedValue(
      Err('VALIDATION', { field: 'path', reason: 'snapshot_not_found' }),
    );
    renderWithAdmin();

    await waitFor(() => {
      expect(screen.getByTestId('backup-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByTestId('backup-restore')[0]!);
    fireEvent.click(screen.getByTestId('backup-restore-confirm-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('backup-restore-error')).toBeInTheDocument();
    });
  });
});
