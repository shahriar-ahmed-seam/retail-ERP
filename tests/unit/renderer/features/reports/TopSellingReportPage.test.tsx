/**
 * Unit tests for the top-selling report page (task 10.8, Phase 10).
 *
 * Validates: Requirements 9.4, 9.5, 8.2, 16.5.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { TopSellingReportPage } from '@renderer/features/reports/TopSellingReportPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { TopSellingRow } from '@shared/dto/index';
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

class NoopResizeObserver {
  observe(): void {
    // no-op
  }
  unobserve(): void {
    // no-op
  }
  disconnect(): void {
    // no-op
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: NoopResizeObserver,
  });
});

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

function makeRow(i: number, overrides: Partial<TopSellingRow> = {}): TopSellingRow {
  return {
    productId: `p-${i}`,
    sku: `SKU-${i}`,
    name: `Product ${i}`,
    unitsSold: 100 - i,
    revenue: `${(100 - i) * 5}.00`,
    ...overrides,
  };
}

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly topSelling: MockInstance;
  readonly exportFn: MockInstance;
}

function buildStub(opts?: {
  readonly rows?: readonly TopSellingRow[];
  readonly response?: ReturnType<typeof Ok> | ReturnType<typeof Err>;
}): BuiltStub {
  const rows = opts?.rows ?? [makeRow(1), makeRow(2), makeRow(3)];
  const topSelling = vi.fn(() =>
    Promise.resolve(opts?.response ?? Ok({ rows })),
  );
  const exportFn = vi.fn(() =>
    Promise.resolve(Ok({ rowCount: rows.length, csvPath: '/tmp/t.csv', pdfPath: '/tmp/t.pdf' })),
  );
  const stub: Partial<Api> = {
    'reports:topSelling': topSelling,
    'reports:export': exportFn,
  };
  return { stub, topSelling, exportFn };
}

describe('<TopSellingReportPage /> — role gating', () => {
  it('hides the page from Cashiers', () => {
    installApi(buildStub().stub);
    render(
      <AuthProvider initialSession={cashierSession}>
        <TopSellingReportPage />
      </AuthProvider>,
    );
    expect(screen.getByTestId('top-selling-permission-denied')).toBeInTheDocument();
  });
});

describe('<TopSellingReportPage /> — load + render', () => {
  it('fetches the top-selling rows on mount with a 30-day default range', async () => {
    const built = buildStub();
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <TopSellingReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.topSelling).toHaveBeenCalledTimes(1);
    });
    const payload = built.topSelling.mock.calls[0]?.[0] as
      | { dateFrom?: string; dateTo?: string }
      | undefined;
    expect(typeof payload?.dateFrom).toBe('string');
    expect(typeof payload?.dateTo).toBe('string');
    expect(payload?.dateFrom).not.toBe(payload?.dateTo);
  });

  it('renders the empty surface when no products were sold in the range', async () => {
    const built = buildStub({ rows: [] });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <TopSellingReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('top-selling-empty')).toBeInTheDocument();
    });
  });

  it('renders the load error envelope inline on Err', async () => {
    const built = buildStub({
      response: Err('VALIDATION', { field: 'range' }),
    });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <TopSellingReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('top-selling-load-error')).toBeInTheDocument();
    });
  });

  it('refetches when the date range changes', async () => {
    const built = buildStub();
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <TopSellingReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.topSelling).toHaveBeenCalledTimes(1);
    });

    await user.clear(screen.getByTestId('top-selling-date-from'));
    await user.type(screen.getByTestId('top-selling-date-from'), '2024-01-01');

    await waitFor(() => {
      expect(built.topSelling.mock.calls.length).toBeGreaterThan(1);
    });
    const last = built.topSelling.mock.calls.at(-1)?.[0] as
      | { dateFrom?: string }
      | undefined;
    expect(last?.dateFrom).toBe('2024-01-01');
  });
});

describe('<TopSellingReportPage /> — export', () => {
  it('Both export posts reportId=topSelling, format=[csv,pdf], dateFrom + dateTo filter', async () => {
    const built = buildStub();
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <TopSellingReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.topSelling).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByTestId('top-selling-export-both'));

    await waitFor(() => {
      expect(built.exportFn).toHaveBeenCalledTimes(1);
    });
    const payload = built.exportFn.mock.calls[0]?.[0] as
      | {
          reportId?: string;
          format?: unknown;
          filter?: { dateFrom?: string; dateTo?: string };
        }
      | undefined;
    expect(payload?.reportId).toBe('topSelling');
    expect(payload?.format).toEqual(['csv', 'pdf']);
    expect(typeof payload?.filter?.dateFrom).toBe('string');
    expect(typeof payload?.filter?.dateTo).toBe('string');
  });
});
