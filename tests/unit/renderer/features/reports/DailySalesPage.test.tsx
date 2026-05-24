/**
 * Unit tests for the daily sales report page (task 10.8, Phase 10).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by `PrinterSettingsPage.test.tsx` and
 * `CustomersListPage.test.tsx`.
 *
 * Coverage:
 *   - Cashier sees the permission-denied surface (Admin-only).
 *   - On mount, fetches `reports:dailySales` for "today" by default.
 *   - Renders totals cards and the per-payment-method breakdown.
 *   - Changing the date triggers a refetch.
 *   - Each export button calls `reports:export` with the right
 *     `reportId` and `format`.
 *   - Load error envelope renders inline.
 *
 * Validates: Requirements 9.1, 9.5, 8.2.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { DailySalesPage } from '@renderer/features/reports/DailySalesPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { DailySalesReport } from '@shared/dto/index';
import type { SessionDTO } from '@shared/ipc-contract';

// ---------------------------------------------------------------------------
// Globals
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
const cashierSession: SessionDTO = {
  sessionId: 's-cashier',
  userId: 'u-cashier',
  username: 'cashier',
  role: 'Cashier',
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<DailySalesReport> = {}): DailySalesReport {
  return {
    date: '2024-01-15',
    salesCount: 12,
    totalRevenue: '1234.56',
    totalTax: '123.45',
    totalDiscount: '45.67',
    paymentBreakdown: [
      { method: 'cash', amount: '500.00' },
      { method: 'card', amount: '700.00' },
    ],
    ...overrides,
  };
}

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly dailySales: MockInstance;
  readonly exportFn: MockInstance;
}

function buildStub(opts?: {
  readonly dailySalesResponse?: ReturnType<typeof Ok> | ReturnType<typeof Err>;
  readonly exportResponse?: ReturnType<typeof Ok> | ReturnType<typeof Err>;
}): BuiltStub {
  const dailySales = vi.fn(() =>
    Promise.resolve(opts?.dailySalesResponse ?? Ok(makeReport())),
  );
  const exportFn = vi.fn(() =>
    Promise.resolve(
      opts?.exportResponse ?? Ok({ rowCount: 12, csvPath: '/tmp/d.csv', pdfPath: '/tmp/d.pdf' }),
    ),
  );
  const stub: Partial<Api> = {
    'reports:dailySales': dailySales as unknown as Api['reports:dailySales'],
    'reports:export': exportFn as unknown as Api['reports:export'],
  };
  return { stub, dailySales, exportFn };
}

// ---------------------------------------------------------------------------
// Tests — role gating
// ---------------------------------------------------------------------------

describe('<DailySalesPage /> — role gating', () => {
  it('shows the permission-denied surface for Cashiers', () => {
    installApi(buildStub().stub);
    render(
      <AuthProvider initialSession={cashierSession}>
        <DailySalesPage />
      </AuthProvider>,
    );
    expect(screen.getByTestId('daily-sales-permission-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('daily-sales-date')).not.toBeInTheDocument();
  });

  it('shows the permission-denied surface for unauthenticated users', () => {
    installApi(buildStub().stub);
    render(
      <AuthProvider initialSession={null}>
        <DailySalesPage />
      </AuthProvider>,
    );
    expect(screen.getByTestId('daily-sales-permission-denied')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — load + render
// ---------------------------------------------------------------------------

describe('<DailySalesPage /> — load + render', () => {
  it('fetches the daily sales report on mount and renders totals and breakdown', async () => {
    const built = buildStub();
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <DailySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.dailySales).toHaveBeenCalledTimes(1);
    });

    // Totals cards
    await waitFor(() => {
      expect(screen.getByTestId('daily-sales-card-count')).toHaveTextContent('12');
    });
    expect(screen.getByTestId('daily-sales-card-revenue')).toHaveTextContent('1234.56');
    expect(screen.getByTestId('daily-sales-card-tax')).toHaveTextContent('123.45');
    expect(screen.getByTestId('daily-sales-card-discount')).toHaveTextContent('45.67');

    // Breakdown
    expect(screen.getByTestId('daily-sales-breakdown-row-cash')).toHaveTextContent('500.00');
    expect(screen.getByTestId('daily-sales-breakdown-row-card')).toHaveTextContent('700.00');

    // Date input is populated
    expect(screen.getByTestId('daily-sales-date')).toBeInTheDocument();
  });

  it('renders the empty breakdown surface when the day has no payments', async () => {
    const built = buildStub({
      dailySalesResponse: Ok(makeReport({ paymentBreakdown: [] })),
    });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <DailySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('daily-sales-breakdown-empty')).toBeInTheDocument();
    });
  });

  it('refetches the report when the date changes', async () => {
    const built = buildStub();
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <DailySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.dailySales).toHaveBeenCalledTimes(1);
    });

    await user.clear(screen.getByTestId('daily-sales-date'));
    await user.type(screen.getByTestId('daily-sales-date'), '2024-02-01');

    await waitFor(() => {
      expect(built.dailySales).toHaveBeenCalledWith({ date: '2024-02-01' });
    });
  });

  it('renders the load error envelope inline on Err', async () => {
    const built = buildStub({
      dailySalesResponse: Err('VALIDATION', { field: 'date' }),
    });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <DailySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('daily-sales-load-error')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — export buttons
// ---------------------------------------------------------------------------

describe('<DailySalesPage /> — export', () => {
  it('Export CSV calls reports:export with reportId=dailySales, format=csv, and the date filter', async () => {
    const built = buildStub();
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <DailySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('daily-sales-card-count')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('daily-sales-export-csv'));

    await waitFor(() => {
      expect(built.exportFn).toHaveBeenCalledTimes(1);
    });
    const payload = built.exportFn.mock.calls[0]?.[0] as
      | {
          reportId?: string;
          format?: unknown;
          filter?: { date?: string };
        }
      | undefined;
    expect(payload?.reportId).toBe('dailySales');
    expect(payload?.format).toBe('csv');
    expect(typeof payload?.filter?.date).toBe('string');

    await waitFor(() => {
      expect(screen.getByTestId('daily-sales-export-success')).toBeInTheDocument();
    });
  });

  it('Export PDF posts format=pdf', async () => {
    const built = buildStub();
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <DailySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('daily-sales-card-count')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('daily-sales-export-pdf'));

    await waitFor(() => {
      expect(built.exportFn).toHaveBeenCalledTimes(1);
    });
    const payload = built.exportFn.mock.calls[0]?.[0] as { format?: unknown };
    expect(payload?.format).toBe('pdf');
  });

  it('Export Both posts format=[csv, pdf]', async () => {
    const built = buildStub();
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <DailySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('daily-sales-card-count')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('daily-sales-export-both'));

    await waitFor(() => {
      expect(built.exportFn).toHaveBeenCalledTimes(1);
    });
    const payload = built.exportFn.mock.calls[0]?.[0] as { format?: unknown };
    expect(payload?.format).toEqual(['csv', 'pdf']);
  });

  it('renders the export error envelope inline on Err', async () => {
    const built = buildStub({
      exportResponse: Err('USER_CANCELED', { format: 'csv' }),
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <DailySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('daily-sales-card-count')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('daily-sales-export-csv'));

    await waitFor(() => {
      expect(screen.getByTestId('daily-sales-export-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('daily-sales-export-error')).toHaveTextContent(/canceled/i);
  });
});
