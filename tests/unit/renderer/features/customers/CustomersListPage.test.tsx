/**
 * Unit tests for the customers list page (task 9.2, Phase 9).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by SuppliersListPage.test.tsx and
 * MovementsBrowserPage.test.tsx. The shared `<VirtualizedTable>` is
 * exercised end-to-end.
 *
 * Coverage:
 *   - Renders customer rows from `customers:list`.
 *   - Cashier sees the directory but no New customer / Edit buttons
 *     (read-only).
 *   - Admin sees the New customer button.
 *   - Phone-prefix input is debounced and forwarded into the request
 *     envelope's `filter.phonePrefix`.
 *   - Error envelope from `customers:list` surfaces inline.
 *
 * Validates: Requirements 7.1, 7.3, 8.3, 16.1, 16.3, 16.5.
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

import { CustomersListPage } from '@renderer/features/customers/CustomersListPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { CustomerDTO, SaleSummaryDTO } from '@shared/dto/index';
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

function makeCustomer(i: number, overrides: Partial<CustomerDTO> = {}): CustomerDTO {
  return {
    id: `c-${i}`,
    name: `Customer ${i}`,
    phone: `555-${String(i).padStart(4, '0')}`,
    createdAt: '2024-01-01T10:00:00.000Z',
    ...overrides,
  };
}

function pageOf(rows: readonly CustomerDTO[]): ListResponse<CustomerDTO> {
  return { rows, nextCursor: null };
}

// ---------------------------------------------------------------------------
// API stub builder
// ---------------------------------------------------------------------------

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly customersList: MockInstance;
  readonly customersCount: MockInstance;
  readonly customersDetail: MockInstance;
  readonly customersUpsert: MockInstance;
}

function buildStub(rows: readonly CustomerDTO[]): BuiltStub {
  const customersList = vi.fn(
    (): Promise<Result<ListResponse<CustomerDTO>>> =>
      Promise.resolve(Ok(pageOf(rows))),
  );
  const customersCount = vi.fn(() =>
    Promise.resolve(Ok({ totalCount: rows.length })),
  );
  // Detail returns the customer with empty history.
  const customersDetail = vi.fn((req: { id: string }) => {
    const customer = rows.find((r) => r.id === req.id) ?? rows[0]!;
    const history: ListResponse<SaleSummaryDTO> = {
      rows: [],
      nextCursor: null,
      totalCount: 0,
    };
    return Promise.resolve(Ok({ customer, history }));
  });
  const customersUpsert = vi.fn();

  const stub: Partial<Api> = {
    'customers:list': customersList,
    'customers:count': customersCount,
    'customers:detail': customersDetail,
    'customers:upsert': customersUpsert,
  };
  return {
    stub,
    customersList,
    customersCount,
    customersDetail,
    customersUpsert,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<CustomersListPage /> — role gating', () => {
  it('shows the permission-denied screen to unauthenticated users', () => {
    const built = buildStub([makeCustomer(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={null}>
        <CustomersListPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('customers-permission-denied')).toBeInTheDocument();
    expect(built.customersList).not.toHaveBeenCalled();
  });

  it('hides the New customer button from Cashiers (read-only)', async () => {
    const built = buildStub([makeCustomer(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={cashierSession}>
        <CustomersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customers-row-c-1')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('customers-new-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('customers-row-edit-c-1')).not.toBeInTheDocument();
  });

  it('shows the New customer and per-row Edit buttons to Admins', async () => {
    const built = buildStub([makeCustomer(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customers-row-c-1')).toBeInTheDocument();
    });

    expect(screen.getByTestId('customers-new-button')).toBeInTheDocument();
    expect(screen.getByTestId('customers-row-edit-c-1')).toBeInTheDocument();
  });
});

describe('<CustomersListPage /> — rendering', () => {
  it('renders rows returned by customers:list', async () => {
    const rows = [makeCustomer(1), makeCustomer(2), makeCustomer(3)];
    const built = buildStub(rows);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customers-row-c-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('customers-row-c-2')).toBeInTheDocument();
    expect(screen.getByTestId('customers-row-c-3')).toBeInTheDocument();
  });

  it('renders the empty state when no rows match', async () => {
    const built = buildStub([]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customers-empty')).toBeInTheDocument();
    });
  });
});

describe('<CustomersListPage /> — phone-prefix search', () => {
  it('forwards the debounced phone prefix as filter.phonePrefix', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const built = buildStub([makeCustomer(1)]);
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomersListPage />
      </AuthProvider>,
    );

    await vi.waitFor(() => {
      expect(built.customersList).toHaveBeenCalled();
    });
    const initialCalls = built.customersList.mock.calls.length;

    await user.type(screen.getByTestId('customers-phone-search'), '555');
    // Mid-debounce: no extra call yet.
    expect(built.customersList.mock.calls.length).toBe(initialCalls);

    // Advance past both the local 300ms debounce AND the table's
    // internal 250ms debounce so the post-debounce call fires.
    await vi.advanceTimersByTimeAsync(700);

    await vi.waitFor(() => {
      expect(built.customersList.mock.calls.length).toBeGreaterThan(initialCalls);
    });

    const lastCall = built.customersList.mock.calls.at(-1)?.[0] as
      | { filter?: { phonePrefix?: string }; cursor?: string }
      | undefined;
    expect(lastCall?.filter?.phonePrefix).toBe('555');
    expect(lastCall?.cursor).toBeUndefined();
  });
});

describe('<CustomersListPage /> — error handling', () => {
  it('renders the error envelope inline when customers:list returns Err', async () => {
    const customersList = vi.fn(() => Promise.resolve(Err('INTERNAL')));
    installApi({
      'customers:list': customersList,
    });

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('virtualized-table-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('virtualized-table-error')).toHaveTextContent(
      'INTERNAL',
    );
  });
});

describe('<CustomersListPage /> — row interactions', () => {
  it('clicking a row opens the customer detail view', async () => {
    const rows = [makeCustomer(1, { name: 'Acme' })];
    const built = buildStub(rows);
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customers-row-c-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('customers-row-c-1'));

    await waitFor(() => {
      expect(built.customersDetail).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c-1' }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('customer-detail-name')).toHaveTextContent('Acme');
    });
  });

  it('clicking the row Edit button opens the form in edit mode', async () => {
    const rows = [makeCustomer(1, { name: 'Acme' })];
    const built = buildStub(rows);
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomersListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('customers-row-edit-c-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('customers-row-edit-c-1'));

    expect(
      screen.getByRole('heading', { name: /edit customer/i }),
    ).toBeInTheDocument();
    // Detail page must NOT be mounted.
    expect(screen.queryByTestId('customer-detail-name')).not.toBeInTheDocument();
  });

  it('clicking New customer opens the form in create mode', async () => {
    const built = buildStub([makeCustomer(1)]);
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomersListPage />
      </AuthProvider>,
    );

    await user.click(screen.getByTestId('customers-new-button'));

    expect(
      screen.getByRole('heading', { name: /new customer/i }),
    ).toBeInTheDocument();
  });
});
