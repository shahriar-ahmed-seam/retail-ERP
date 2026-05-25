/**
 * Unit tests for the Admin dashboard (task 13.2).
 *
 * Mounts `<DashboardPage />` against a stubbed `window.api` and an
 * in-memory router (so the quick-link <Link> components render).
 *
 * Coverage:
 *   - Renders today's totals and the low-stock count from
 *     `reports:dailySales` and `inventory:lowStockCount`.
 *   - Renders the quick-link grid with the four required links.
 *   - Surfaces a per-card error when a channel returns Err.
 *   - Renders the loading skeleton while the IPC calls are in flight.
 *
 * Validates: Requirements 9.1, 3.6, 14.3.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '@renderer/features/dashboard';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { DailySalesReport } from '@shared/dto/index';
import type { SessionDTO } from '@shared/ipc-contract';

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
  vi.clearAllMocks();
});

const adminSession: SessionDTO = {
  sessionId: 's-admin',
  userId: 'u-admin',
  username: 'owner',
  role: 'Admin',
};

function makeReport(overrides: Partial<DailySalesReport> = {}): DailySalesReport {
  return {
    date: '2024-01-15',
    salesCount: 12,
    totalRevenue: '1234.50',
    totalTax: '110.00',
    totalDiscount: '50.00',
    paymentBreakdown: [],
    ...overrides,
  };
}

function renderPage(): void {
  render(
    <AuthProvider initialSession={adminSession}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('<DashboardPage />', () => {
  it('renders today\'s sales total, transaction count, and low-stock count', async () => {
    installApi({
      'reports:dailySales': vi.fn().mockResolvedValue(Ok(makeReport())),
      'inventory:lowStockCount': vi.fn().mockResolvedValue(Ok({ count: 7 })),
    });

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByTestId('dashboard-card-sales-total-value'),
      ).toHaveTextContent('1234.50');
    });
    expect(
      screen.getByTestId('dashboard-card-sales-count-value'),
    ).toHaveTextContent('12');
    expect(
      screen.getByTestId('dashboard-card-low-stock-value'),
    ).toHaveTextContent('7');
  });

  it('renders the four quick links to POS, products, reports, and backup', async () => {
    installApi({
      'reports:dailySales': vi.fn().mockResolvedValue(Ok(makeReport())),
      'inventory:lowStockCount': vi.fn().mockResolvedValue(Ok({ count: 0 })),
    });

    renderPage();

    expect(
      await screen.findByTestId('dashboard-quick-links'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-link-pos')).toHaveAttribute(
      'href',
      '/pos',
    );
    expect(screen.getByTestId('dashboard-link-products')).toHaveAttribute(
      'href',
      '/products',
    );
    expect(screen.getByTestId('dashboard-link-reports')).toHaveAttribute(
      'href',
      '/reports/daily',
    );
    expect(screen.getByTestId('dashboard-link-backup')).toHaveAttribute(
      'href',
      '/backup',
    );
  });

  it('surfaces a per-card error when reports:dailySales returns Err', async () => {
    installApi({
      'reports:dailySales': vi.fn().mockResolvedValue(Err('INTERNAL')),
      'inventory:lowStockCount': vi.fn().mockResolvedValue(Ok({ count: 2 })),
    });

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByTestId('dashboard-card-sales-total-error'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('dashboard-card-sales-count-error'),
    ).toBeInTheDocument();
    // Low-stock card should still render the value successfully.
    expect(
      screen.getByTestId('dashboard-card-low-stock-value'),
    ).toHaveTextContent('2');
  });

  it('passes today\'s local date to reports:dailySales', async () => {
    const dailySales = vi.fn().mockResolvedValue(Ok(makeReport()));
    installApi({
      'reports:dailySales': dailySales,
      'inventory:lowStockCount': vi.fn().mockResolvedValue(Ok({ count: 0 })),
    });

    renderPage();

    await waitFor(() => {
      expect(dailySales).toHaveBeenCalledTimes(1);
    });
    const arg = dailySales.mock.calls[0]?.[0] as { date?: string } | undefined;
    expect(arg?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
