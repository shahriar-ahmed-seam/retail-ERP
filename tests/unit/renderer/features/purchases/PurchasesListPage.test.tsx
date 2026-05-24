/**
 * Unit tests for the read-only purchases list page (task 6.3).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by `MovementsBrowserPage.test.tsx` and
 * `SuppliersListPage.test.tsx`. The shared `<VirtualizedTable>` is
 * exercised end-to-end — these tests verify the integration, not the
 * table's internal page-accumulation logic (already covered by its own
 * suite).
 *
 * Coverage:
 *   - Renders rows from a mocked `purchases:list` first page.
 *   - Debounced supplier search forwards a single request after the
 *     250 ms window and resets the cursor on the resulting list call.
 *   - Date-range filter resets the cursor and forwards inclusive ISO
 *     timestamps.
 *   - Row count surfaces when `withCount` is enabled (the totals strip
 *     reads "Showing N of M").
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 16.1, 16.3, 16.5.
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

import { PurchasesListPage } from '@renderer/features/purchases/PurchasesListPage';
import { Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type {
  PurchaseSummaryDTO,
  SupplierDTO,
} from '@shared/dto/index';
import type { ListResponse } from '@shared/ipc-contract';

// ---------------------------------------------------------------------------
// jsdom shims & global helpers
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
  vi.useRealTimers();
});

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
  // jsdom does not implement ResizeObserver; react-window v2 calls
  // `new ResizeObserver()` to track its container's box.
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: NoopResizeObserver,
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePurchase(
  i: number,
  overrides: Partial<PurchaseSummaryDTO> = {},
): PurchaseSummaryDTO {
  return {
    id: `pur-${String(i)}`,
    supplierId: `sup-${String(i)}`,
    supplierName: `Supplier ${String(i)}`,
    invoiceNo: `INV-${String(i)}`,
    total: '100.00',
    itemCount: 2,
    createdAt: `2026-05-2${String(i % 10)}T10:00:00.000Z`,
    ...overrides,
  };
}

function makeSupplier(i: number, overrides: Partial<SupplierDTO> = {}): SupplierDTO {
  return {
    id: `sup-${String(i)}`,
    name: `Supplier ${String(i)}`,
    phone: '555-0',
    address: '1 Way',
    ...overrides,
  };
}

function pageOf<T>(rows: readonly T[], totalCount?: number): ListResponse<T> {
  if (totalCount !== undefined) {
    return { rows, nextCursor: null, totalCount };
  }
  return { rows, nextCursor: null };
}

// ---------------------------------------------------------------------------
// API stub builder
// ---------------------------------------------------------------------------

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly purchasesList: MockInstance;
  readonly purchasesCount: MockInstance;
  readonly suppliersList: MockInstance;
}

function buildStub(opts: {
  purchases: readonly PurchaseSummaryDTO[];
  totalCount?: number;
  suppliers?: readonly SupplierDTO[];
}): BuiltStub {
  const purchasesList = vi.fn(() =>
    Promise.resolve(Ok(pageOf(opts.purchases))),
  );
  const purchasesCount = vi.fn(() =>
    Promise.resolve(Ok({ totalCount: opts.totalCount ?? opts.purchases.length })),
  );
  const suppliersList = vi.fn(() =>
    Promise.resolve(Ok(pageOf(opts.suppliers ?? []))),
  );

  const stub: Partial<Api> = {
    'purchases:list': purchasesList,
    'purchases:count': purchasesCount,
    'suppliers:list': suppliersList,
  };
  return { stub, purchasesList, purchasesCount, suppliersList };
}

// ---------------------------------------------------------------------------
// Tests — rendering
// ---------------------------------------------------------------------------

describe('<PurchasesListPage /> — rendering', () => {
  it('renders rows returned by purchases:list', async () => {
    const rows = [makePurchase(1), makePurchase(2), makePurchase(3)];
    const built = buildStub({ purchases: rows });
    installApi(built.stub);

    render(<PurchasesListPage />);

    await waitFor(() => {
      expect(screen.getByTestId('purchases-row-pur-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('purchases-row-pur-2')).toBeInTheDocument();
    expect(screen.getByTestId('purchases-row-pur-3')).toBeInTheDocument();
    expect(screen.getByTestId('purchases-table-header')).toBeInTheDocument();
  });

  it('exposes the row count when withCount is enabled', async () => {
    const rows = [makePurchase(1), makePurchase(2)];
    const built = buildStub({ purchases: rows, totalCount: 7 });
    installApi(built.stub);

    render(<PurchasesListPage />);

    await waitFor(() => {
      expect(built.purchasesCount).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('virtualized-table-totals'),
      ).toHaveTextContent(/Showing 2 of 7/);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — supplier search debounce
// ---------------------------------------------------------------------------

describe('<PurchasesListPage /> — supplier search debounce', () => {
  it('forwards a single suppliers:list request after the debounce window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const supplier = makeSupplier(1, { name: 'Acme Tools' });
    const built = buildStub({ purchases: [], suppliers: [supplier] });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PurchasesListPage />);

    await user.type(screen.getByTestId('purchases-supplier-search'), 'Acme');

    // Before the debounce window, no IPC should have fired.
    expect(built.suppliersList).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => {
      expect(built.suppliersList).toHaveBeenCalledTimes(1);
    });

    const callArg = built.suppliersList.mock.calls[0]?.[0] as
      | { search?: string; pageSize?: number }
      | undefined;
    expect(callArg?.search).toBe('Acme');
    expect(callArg?.pageSize).toBe(20);
  });

  it('selecting a supplier resets the cursor and re-issues purchases:list with the supplierId filter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const supplier = makeSupplier(1, { name: 'Acme' });
    const built = buildStub({ purchases: [], suppliers: [supplier] });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PurchasesListPage />);

    await waitFor(() => {
      expect(built.purchasesList).toHaveBeenCalled();
    });
    const callsBefore = built.purchasesList.mock.calls.length;

    await user.type(screen.getByTestId('purchases-supplier-search'), 'Acme');
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => {
      expect(
        screen.getByTestId(`purchases-supplier-result-${supplier.id}`),
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getByTestId(`purchases-supplier-result-${supplier.id}`),
    );

    await waitFor(() => {
      expect(built.purchasesList.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    const lastReq = built.purchasesList.mock.calls.at(-1)?.[0] as
      | { filter?: { supplierId?: string }; cursor?: string }
      | undefined;
    expect(lastReq?.filter?.supplierId).toBe(supplier.id);
    expect(lastReq?.cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — date-range filter
// ---------------------------------------------------------------------------

describe('<PurchasesListPage /> — date-range filter', () => {
  it('forwards inclusive ISO timestamps and resets the cursor', async () => {
    const built = buildStub({ purchases: [makePurchase(1)] });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<PurchasesListPage />);

    await waitFor(() => {
      expect(built.purchasesList).toHaveBeenCalled();
    });

    const callsBefore = built.purchasesList.mock.calls.length;

    await user.type(screen.getByTestId('purchases-date-from'), '2026-05-01');
    await user.type(screen.getByTestId('purchases-date-to'), '2026-05-31');

    await waitFor(() => {
      expect(built.purchasesList.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    const lastReq = built.purchasesList.mock.calls.at(-1)?.[0] as
      | {
          filter?: { dateFrom?: string; dateTo?: string };
          cursor?: string;
        }
      | undefined;
    expect(lastReq?.filter?.dateFrom).toBe('2026-05-01T00:00:00.000Z');
    expect(lastReq?.filter?.dateTo).toBe('2026-05-31T23:59:59.999Z');
    expect(lastReq?.cursor).toBeUndefined();
  });
});
