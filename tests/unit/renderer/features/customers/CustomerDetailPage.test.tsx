/**
 * Unit tests for the customer detail page (task 9.2, Phase 9).
 *
 * Coverage:
 *   - Loads customer and history on mount.
 *   - Renders customer header.
 *   - Renders sale history rows.
 *   - Loads more pages when "Load more" is clicked.
 *   - Renders not-found surface on FK_VIOLATION.
 *   - Calls onClose when Back is clicked.
 *   - Hides the Edit button when onEdit prop is omitted (Cashier path).
 *
 * Validates: Requirements 7.1, 7.3, 8.3, 16.1, 16.2.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomerDetailPage } from '@renderer/features/customers/CustomerDetailPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { CustomerDTO, SaleSummaryDTO } from '@shared/dto/index';
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

const customer: CustomerDTO = {
  id: 'c-1',
  name: 'Alice',
  phone: '555-1',
  createdAt: '2024-01-01T10:00:00.000Z',
};

function makeSale(i: number): SaleSummaryDTO {
  return {
    id: `s-${i}`,
    serialNo: `INV-${String(i).padStart(6, '0')}`,
    grandTotal: '100.00',
    customerName: 'Alice',
    cashierName: 'cashier1',
    createdAt: '2024-01-01T10:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests — load and render
// ---------------------------------------------------------------------------

describe('<CustomerDetailPage /> — load and render', () => {
  it('shows customer header and history rows', async () => {
    const detail = vi.fn().mockResolvedValue(
      Ok({
        customer,
        history: {
          rows: [makeSale(1), makeSale(2)],
          nextCursor: null,
          totalCount: 2,
        } satisfies ListResponse<SaleSummaryDTO>,
      }),
    );

    installApi({ 'customers:detail': detail });

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerDetailPage customerId="c-1" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-name')).toHaveTextContent('Alice');
    });
    expect(screen.getByTestId('customer-detail-phone')).toHaveTextContent('555-1');
    expect(screen.getByTestId('customer-detail-history-row-s-1')).toBeInTheDocument();
    expect(screen.getByTestId('customer-detail-history-row-s-2')).toBeInTheDocument();
  });

  it('shows the empty history state when there are no sales', async () => {
    const detail = vi.fn().mockResolvedValue(
      Ok({
        customer,
        history: { rows: [], nextCursor: null, totalCount: 0 },
      }),
    );

    installApi({ 'customers:detail': detail });

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerDetailPage customerId="c-1" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-history-empty')).toBeInTheDocument();
    });
  });

  it('renders the Edit button only when onEdit is provided (Admin path)', async () => {
    const detail = vi.fn().mockResolvedValue(
      Ok({
        customer,
        history: { rows: [], nextCursor: null, totalCount: 0 },
      }),
    );

    installApi({ 'customers:detail': detail });
    const onEdit = vi.fn();

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerDetailPage customerId="c-1" onClose={vi.fn()} onEdit={onEdit} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-edit')).toBeInTheDocument();
    });
  });

  it('hides the Edit button when onEdit is omitted (Cashier path)', async () => {
    const detail = vi.fn().mockResolvedValue(
      Ok({
        customer,
        history: { rows: [], nextCursor: null, totalCount: 0 },
      }),
    );

    installApi({ 'customers:detail': detail });

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerDetailPage customerId="c-1" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-name')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('customer-detail-edit')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — load more
// ---------------------------------------------------------------------------

describe('<CustomerDetailPage /> — load more', () => {
  it('appends rows on subsequent calls and stops when cursor is null', async () => {
    let call = 0;
    const detail = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          Ok({
            customer,
            history: {
              rows: [makeSale(1)],
              nextCursor: 'cursor-tok',
              totalCount: 2,
            },
          }),
        );
      }
      return Promise.resolve(
        Ok({
          customer,
          history: {
            rows: [makeSale(2)],
            nextCursor: null,
            totalCount: 2,
          },
        }),
      );
    });

    installApi({ 'customers:detail': detail });

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerDetailPage customerId="c-1" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-history-row-s-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('customer-detail-load-more'));

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-history-row-s-2')).toBeInTheDocument();
    });

    expect(detail).toHaveBeenCalledTimes(2);
    const secondCall = detail.mock.calls[1]?.[0] as
      | { history?: { cursor?: string } }
      | undefined;
    expect(secondCall?.history?.cursor).toBe('cursor-tok');

    // No more "Load more" because nextCursor is null.
    expect(screen.queryByTestId('customer-detail-load-more')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — error handling
// ---------------------------------------------------------------------------

describe('<CustomerDetailPage /> — error handling', () => {
  it('renders a not-found surface on FK_VIOLATION', async () => {
    const detail = vi
      .fn()
      .mockResolvedValue(Err('FK_VIOLATION', { reason: 'not_found' }));
    installApi({ 'customers:detail': detail });

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerDetailPage customerId="gone" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/customer not found/i)).toBeInTheDocument();
  });

  it('renders the generic error surface on other envelopes', async () => {
    const detail = vi.fn().mockResolvedValue(Err('INTERNAL'));
    installApi({ 'customers:detail': detail });

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerDetailPage customerId="c-1" onClose={vi.fn()} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/failed to load customer/i)).toBeInTheDocument();
  });

  it('calls onClose when "Back" is clicked', async () => {
    const detail = vi.fn().mockResolvedValue(
      Ok({
        customer,
        history: { rows: [], nextCursor: null, totalCount: 0 },
      }),
    );
    installApi({ 'customers:detail': detail });
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerDetailPage customerId="c-1" onClose={onClose} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-back')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('customer-detail-back'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
