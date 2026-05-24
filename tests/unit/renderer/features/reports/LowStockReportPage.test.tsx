/**
 * Unit tests for the low-stock report page (task 10.8, Phase 10).
 *
 * Mounts the real component against a stubbed `window.api`. The page
 * is available to both Admin and Cashier (the persistent banner
 * clicks through here for both roles), so role gating tests cover
 * "unauthenticated user" only.
 *
 * Validates: Requirements 9.3, 9.5, 3.6, 16.5.
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

import { LowStockReportPage } from '@renderer/features/reports/LowStockReportPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { LowStockRow } from '@shared/dto/index';
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

function makeRow(i: number, overrides: Partial<LowStockRow> = {}): LowStockRow {
  return {
    productId: `p-${i}`,
    sku: `SKU-${i}`,
    name: `Product ${i}`,
    onHand: 1,
    reorderLevel: 5,
    ...overrides,
  };
}

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly lowStock: MockInstance;
  readonly exportFn: MockInstance;
}

function buildStub(opts?: {
  readonly rows?: readonly LowStockRow[];
  readonly response?: ReturnType<typeof Ok> | ReturnType<typeof Err>;
}): BuiltStub {
  const rows = opts?.rows ?? [makeRow(1), makeRow(2, { onHand: 0 })];
  const lowStock = vi.fn(() =>
    Promise.resolve(opts?.response ?? Ok({ rows })),
  );
  const exportFn = vi.fn(() =>
    Promise.resolve(Ok({ rowCount: rows.length, csvPath: '/tmp/l.csv', pdfPath: '/tmp/l.pdf' })),
  );
  const stub: Partial<Api> = {
    'reports:lowStock': lowStock,
    'reports:export': exportFn,
  };
  return { stub, lowStock, exportFn };
}

describe('<LowStockReportPage /> — role gating', () => {
  it('shows the permission-denied surface for unauthenticated users', () => {
    installApi(buildStub().stub);
    render(
      <AuthProvider initialSession={null}>
        <LowStockReportPage />
      </AuthProvider>,
    );
    expect(screen.getByTestId('low-stock-permission-denied')).toBeInTheDocument();
  });

  it('renders for Cashier (the click-through surface for the banner)', async () => {
    const built = buildStub();
    installApi(built.stub);
    render(
      <AuthProvider initialSession={cashierSession}>
        <LowStockReportPage />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(built.lowStock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('low-stock-permission-denied')).not.toBeInTheDocument();
  });
});

describe('<LowStockReportPage /> — load + render', () => {
  it('fetches the low-stock summary on mount and renders rows', async () => {
    const built = buildStub();
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <LowStockReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.lowStock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getByTestId('low-stock-summary')).toHaveTextContent(
        /2 product/i,
      );
    });
  });

  it('renders the empty surface when no products are low', async () => {
    const built = buildStub({ rows: [] });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <LowStockReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('low-stock-summary')).toHaveTextContent(
        /all stock levels/i,
      );
    });
  });

  it('renders the load error envelope inline on Err', async () => {
    const built = buildStub({ response: Err('INTERNAL') });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <LowStockReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('low-stock-load-error')).toBeInTheDocument();
    });
  });

  it('refreshes when the Refresh button is clicked', async () => {
    const built = buildStub();
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <LowStockReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.lowStock).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByTestId('low-stock-refresh'));

    await waitFor(() => {
      expect(built.lowStock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('<LowStockReportPage /> — export', () => {
  it('CSV export calls reports:export with reportId=lowStock', async () => {
    const built = buildStub();
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <LowStockReportPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('low-stock-summary')).toHaveTextContent(/2 product/i);
    });

    await user.click(screen.getByTestId('low-stock-export-csv'));

    await waitFor(() => {
      expect(built.exportFn).toHaveBeenCalledTimes(1);
    });
    const payload = built.exportFn.mock.calls[0]?.[0] as
      | { reportId?: string; format?: unknown }
      | undefined;
    expect(payload?.reportId).toBe('lowStock');
    expect(payload?.format).toBe('csv');
  });
});
