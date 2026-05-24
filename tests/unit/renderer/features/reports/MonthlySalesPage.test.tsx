/**
 * Unit tests for the monthly sales report page (task 10.8, Phase 10).
 *
 * Mirrors `DailySalesPage.test.tsx` minus the per-payment-method
 * breakdown — Req 9.2 limits the monthly report to headline figures.
 *
 * Validates: Requirements 9.2, 9.5, 8.2.
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

import { MonthlySalesPage } from '@renderer/features/reports/MonthlySalesPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { MonthlySalesReport } from '@shared/dto/index';
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

function makeReport(overrides: Partial<MonthlySalesReport> = {}): MonthlySalesReport {
  return {
    month: '2024-01',
    salesCount: 200,
    totalRevenue: '12345.67',
    totalTax: '1234.56',
    totalDiscount: '345.67',
    ...overrides,
  };
}

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly monthlySales: MockInstance;
  readonly exportFn: MockInstance;
}

function buildStub(opts?: {
  readonly response?: ReturnType<typeof Ok> | ReturnType<typeof Err>;
}): BuiltStub {
  const monthlySales = vi.fn(() =>
    Promise.resolve(opts?.response ?? Ok(makeReport())),
  );
  const exportFn = vi.fn(() =>
    Promise.resolve(Ok({ rowCount: 200, csvPath: '/tmp/m.csv', pdfPath: '/tmp/m.pdf' })),
  );
  const stub: Partial<Api> = {
    'reports:monthlySales': monthlySales,
    'reports:export': exportFn,
  };
  return { stub, monthlySales, exportFn };
}

describe('<MonthlySalesPage /> — role gating', () => {
  it('hides the page from Cashiers', () => {
    installApi(buildStub().stub);
    render(
      <AuthProvider initialSession={cashierSession}>
        <MonthlySalesPage />
      </AuthProvider>,
    );
    expect(screen.getByTestId('monthly-sales-permission-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('monthly-sales-month')).not.toBeInTheDocument();
  });
});

describe('<MonthlySalesPage /> — load + render', () => {
  it('fetches the monthly report on mount and renders headline totals', async () => {
    const built = buildStub();
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <MonthlySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.monthlySales).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getByTestId('monthly-sales-card-count')).toHaveTextContent('200');
    });
    expect(screen.getByTestId('monthly-sales-card-revenue')).toHaveTextContent('12345.67');
    expect(screen.getByTestId('monthly-sales-card-tax')).toHaveTextContent('1234.56');
    expect(screen.getByTestId('monthly-sales-card-discount')).toHaveTextContent('345.67');
  });

  it('renders the load error inline on Err', async () => {
    const built = buildStub({
      response: Err('VALIDATION', { field: 'month' }),
    });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <MonthlySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('monthly-sales-load-error')).toBeInTheDocument();
    });
  });
});

describe('<MonthlySalesPage /> — export', () => {
  it('CSV export posts reportId=monthlySales, format=csv, filter.month', async () => {
    const built = buildStub();
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <MonthlySalesPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('monthly-sales-card-count')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('monthly-sales-export-csv'));

    await waitFor(() => {
      expect(built.exportFn).toHaveBeenCalledTimes(1);
    });
    const payload = built.exportFn.mock.calls[0]?.[0] as
      | { reportId?: string; format?: unknown; filter?: { month?: string } }
      | undefined;
    expect(payload?.reportId).toBe('monthlySales');
    expect(payload?.format).toBe('csv');
    expect(typeof payload?.filter?.month).toBe('string');
  });
});
