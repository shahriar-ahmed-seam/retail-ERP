/**
 * Unit tests for the suppliers list page (task 6.1, Phase 6).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by ProductsListPage.test.tsx and
 * MovementsBrowserPage.test.tsx. The shared `<VirtualizedTable>` is
 * exercised end-to-end.
 *
 * Coverage:
 *   - Renders supplier rows from `suppliers:list`.
 *   - Cashier sees the permission-denied screen (Req 8.2).
 *   - Admin sees the New supplier button.
 *   - Search input is forwarded into the request envelope after the
 *     debounce window.
 *   - Clicking a row opens the detail page; clicking Edit opens the
 *     form.
 *
 * Validates: Requirements 6.1, 6.2, 8.2, 16.1, 16.3, 16.5.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { SuppliersListPage } from '@renderer/features/suppliers/SuppliersListPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { PurchaseSummaryDTO, SupplierDTO } from '@shared/dto/index';
import type { ListResponse, SessionDTO } from '@shared/ipc-contract';
import type { Result } from '@shared/result';

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
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: NoopResizeObserver,
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makeSupplier(i: number, overrides: Partial<SupplierDTO> = {}): SupplierDTO {
  return {
    id: `s-${i}`,
    name: `Supplier ${i}`,
    phone: '555-0',
    address: '1 Way',
    ...overrides,
  };
}

function pageOf(rows: readonly SupplierDTO[]): ListResponse<SupplierDTO> {
  return { rows, nextCursor: null };
}

// ---------------------------------------------------------------------------
// API stub builder
// ---------------------------------------------------------------------------

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly suppliersList: MockInstance;
  readonly suppliersCount: MockInstance;
  readonly suppliersDetail: MockInstance;
  readonly suppliersUpsert: MockInstance;
}

function buildStub(rows: readonly SupplierDTO[]): BuiltStub {
  const suppliersList = vi.fn(
    (): Promise<Result<ListResponse<SupplierDTO>>> =>
      Promise.resolve(Ok(pageOf(rows))),
  );
  const suppliersCount = vi.fn(() =>
    Promise.resolve(Ok({ totalCount: rows.length })),
  );
  // Detail returns the supplier with empty history.
  const suppliersDetail = vi.fn((req: { id: string }) => {
    const supplier = rows.find((r) => r.id === req.id) ?? rows[0]!;
    const history: ListResponse<PurchaseSummaryDTO> = {
      rows: [],
      nextCursor: null,
      totalCount: 0,
    };
    return Promise.resolve(Ok({ supplier, history }));
  });
  const suppliersUpsert = vi.fn();

  const stub: Partial<Api> = {
    'suppliers:list': suppliersList,
    'suppliers:count': suppliersCount,
    'suppliers:detail': suppliersDetail,
    'suppliers:upsert': suppliersUpsert,
  };
  return { stub, suppliersList, suppliersCount, suppliersDetail, suppliersUpsert };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<SuppliersListPage /> — role gating', () => {
  it('shows the permission-denied screen to Cashiers', () => {
    const built = buildStub([makeSupplier(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={cashierSession}>
        <SuppliersListPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('suppliers-permission-denied')).toBeInTheDocument();
    expect(built.suppliersList).not.toHaveBeenCalled();
  });

  it('shows the New supplier button to Admins', () => {
    const built = buildStub([makeSupplier(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <SuppliersListPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('suppliers-new-button')).toBeInTheDocument();
  });
});

describe('<SuppliersListPage /> — rendering', () => {
  it('renders rows returned by suppliers:list', async () => {
    const rows = [makeSupplier(1), makeSupplier(2), makeSupplier(3)];
    const built = buildStub(rows);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <SuppliersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('suppliers-row-s-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('suppliers-row-s-2')).toBeInTheDocument();
    expect(screen.getByTestId('suppliers-row-s-3')).toBeInTheDocument();
  });
});

describe('<SuppliersListPage /> — search debouncing', () => {
  it('forwards search input to suppliers:list after the debounce window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const built = buildStub([makeSupplier(1)]);
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <AuthProvider initialSession={adminSession}>
        <SuppliersListPage />
      </AuthProvider>,
    );

    await vi.waitFor(() => {
      expect(built.suppliersList).toHaveBeenCalled();
    });
    const initialCalls = built.suppliersList.mock.calls.length;

    await user.type(screen.getByLabelText(/search/i), 'acme');
    expect(built.suppliersList.mock.calls.length).toBe(initialCalls);

    await vi.advanceTimersByTimeAsync(300);

    await vi.waitFor(() => {
      expect(built.suppliersList.mock.calls.length).toBeGreaterThan(initialCalls);
    });

    const lastCall = built.suppliersList.mock.calls.at(-1)?.[0] as
      | { search?: string; cursor?: string }
      | undefined;
    expect(lastCall?.search).toBe('acme');
    expect(lastCall?.cursor).toBeUndefined();
  });
});

describe('<SuppliersListPage /> — row click opens detail', () => {
  it('clicking a row opens the supplier detail view', async () => {
    const rows = [makeSupplier(1, { name: 'Acme' })];
    const built = buildStub(rows);
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <SuppliersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('suppliers-row-s-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('suppliers-row-s-1'));

    await waitFor(() => {
      expect(built.suppliersDetail).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's-1' }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('supplier-detail-name')).toHaveTextContent('Acme');
    });
  });

  it('clicking the row Edit button opens the form in edit mode', async () => {
    const rows = [makeSupplier(1, { name: 'Acme' })];
    const built = buildStub(rows);
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <SuppliersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('suppliers-row-edit-s-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('suppliers-row-edit-s-1'));

    // Form is mounted; the heading reads "Edit supplier".
    expect(screen.getByRole('heading', { name: /edit supplier/i })).toBeInTheDocument();
    // Detail page must NOT be mounted.
    expect(screen.queryByTestId('supplier-detail-name')).not.toBeInTheDocument();
  });
});

describe('<SuppliersListPage /> — New supplier button', () => {
  it('opens the form in create mode', async () => {
    const built = buildStub([makeSupplier(1)]);
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <SuppliersListPage />
      </AuthProvider>,
    );

    await user.click(screen.getByTestId('suppliers-new-button'));

    expect(screen.getByRole('heading', { name: /new supplier/i })).toBeInTheDocument();
  });
});
