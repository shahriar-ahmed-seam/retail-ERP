/**
 * Unit tests for the supplier detail page (task 6.1, Phase 6).
 *
 * Coverage:
 *   - Loads supplier and history on mount.
 *   - Renders supplier header.
 *   - Renders purchase history rows.
 *   - Loads more pages when "Load more" is clicked.
 *   - Renders not-found surface on FK_VIOLATION.
 *
 * Validates: Requirements 6.1, 6.3, 16.1, 16.2.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SupplierDetailPage } from '@renderer/features/suppliers/SupplierDetailPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { PurchaseSummaryDTO, SupplierDTO } from '@shared/dto/index';
import type { ListResponse, SessionDTO } from '@shared/ipc-contract';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type GlobalWithWindow = typeof globalThis & {
  window: Window & { api?: Partial<Api> };
};

const g = globalThis as unknown as GlobalWithWindow;

function installApi(stub: Partial<Api>): void {
  g.window.api = stub;
}

function uninstallApi(): void {
  delete g.window.api;
}

afterEach(() => {
  uninstallApi();
});

const adminSession: SessionDTO = {
  sessionId: 's-admin',
  userId: 'u-admin',
  username: 'admin',
  role: 'Admin',
};

const supplier: SupplierDTO = {
  id: 's-1',
  name: 'Acme',
  phone: '555-1',
  address: 'Lane',
};

function makePurchase(i: number): PurchaseSummaryDTO {
  return {
    id: `p-${i}`,
    supplierId: 's-1',
    supplierName: 'Acme',
    invoiceNo: `INV-${i}`,
    total: '100.00',
    itemCount: 2,
    createdAt: '2024-01-01T10:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<SupplierDetailPage /> — load and render', () => {
  it('shows supplier header and history rows', async () => {
    const detail = vi.fn().mockResolvedValue(
      Ok({
        supplier,
        history: {
          rows: [makePurchase(1), makePurchase(2)],
          nextCursor: null,
          totalCount: 2,
        } satisfies ListResponse<PurchaseSummaryDTO>,
      }),
    );

    installApi({ 'suppliers:detail': detail });

    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierDetailPage supplierId="s-1" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('supplier-detail-name')).toHaveTextContent('Acme');
    });
    expect(screen.getByTestId('supplier-detail-phone')).toHaveTextContent('555-1');
    expect(screen.getByTestId('supplier-detail-history-row-p-1')).toBeInTheDocument();
    expect(screen.getByTestId('supplier-detail-history-row-p-2')).toBeInTheDocument();
  });

  it('shows the empty history state when there are no purchases', async () => {
    const detail = vi.fn().mockResolvedValue(
      Ok({
        supplier,
        history: { rows: [], nextCursor: null, totalCount: 0 },
      }),
    );

    installApi({ 'suppliers:detail': detail });

    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierDetailPage supplierId="s-1" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('supplier-detail-history-empty')).toBeInTheDocument();
    });
  });
});

describe('<SupplierDetailPage /> — load more', () => {
  it('appends rows on subsequent calls and stops when cursor is null', async () => {
    let call = 0;
    const detail = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          Ok({
            supplier,
            history: {
              rows: [makePurchase(1)],
              nextCursor: 'cursor-tok',
              totalCount: 2,
            },
          }),
        );
      }
      return Promise.resolve(
        Ok({
          supplier,
          history: {
            rows: [makePurchase(2)],
            nextCursor: null,
            totalCount: 2,
          },
        }),
      );
    });

    installApi({ 'suppliers:detail': detail });

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierDetailPage supplierId="s-1" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('supplier-detail-history-row-p-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('supplier-detail-load-more'));

    await waitFor(() => {
      expect(screen.getByTestId('supplier-detail-history-row-p-2')).toBeInTheDocument();
    });

    expect(detail).toHaveBeenCalledTimes(2);
    const secondCall = detail.mock.calls[1]?.[0] as
      | { history?: { cursor?: string } }
      | undefined;
    expect(secondCall?.history?.cursor).toBe('cursor-tok');

    // No more "Load more" because nextCursor is null.
    expect(screen.queryByTestId('supplier-detail-load-more')).not.toBeInTheDocument();
  });
});

describe('<SupplierDetailPage /> — error handling', () => {
  it('renders a not-found surface on FK_VIOLATION', async () => {
    const detail = vi
      .fn()
      .mockResolvedValue(Err('FK_VIOLATION', { reason: 'not_found' }));
    installApi({ 'suppliers:detail': detail });

    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierDetailPage supplierId="gone" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('supplier-detail-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/supplier not found/i)).toBeInTheDocument();
  });

  it('calls onClose when "Back" is clicked', async () => {
    const detail = vi.fn().mockResolvedValue(
      Ok({
        supplier,
        history: { rows: [], nextCursor: null, totalCount: 0 },
      }),
    );
    installApi({ 'suppliers:detail': detail });
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierDetailPage supplierId="s-1" onClose={onClose} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('supplier-detail-back')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('supplier-detail-back'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
