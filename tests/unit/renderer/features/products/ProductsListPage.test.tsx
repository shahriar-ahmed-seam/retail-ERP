/**
 * Unit tests for the products list page (task 4.4).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by `LoginPage.test.tsx` and
 * `VirtualizedTable.test.tsx`. The shared `<VirtualizedTable>` is
 * exercised end-to-end — these tests verify the integration, not the
 * table's internal page-accumulation logic (already covered by its own
 * suite).
 *
 * Coverage:
 *
 *   - Renders three product rows from `products:list`.
 *   - Admin sees the "New product" button; Cashier does not (Req 8.3).
 *   - Search input is forwarded into the request envelope after the
 *     250 ms debounce window. Filter changes reset the cursor — the
 *     hook does this by re-issuing the first-page request, so the
 *     latest call seen by the spy carries no `cursor`.
 *   - Toggling the low-stock checkbox surfaces
 *     `filter.lowStockOnly: true` in the request.
 *
 * The renderer's typed API wrapper reads `window.api` lazily, so each
 * test installs a stub and tears it down in `afterEach`.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 8.3, 16.1, 16.3, 16.5.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { ProductsListPage } from '@renderer/features/products/ProductsListPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { CategoryDTO, ProductDTO } from '@shared/dto/index';
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

const categories: readonly CategoryDTO[] = [
  { id: 'c-fruit', name: 'Fruit' },
  { id: 'c-veg', name: 'Vegetable' },
];

function makeProduct(i: number, overrides: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: `p-${i}`,
    sku: `SKU-${i}`,
    name: `Product ${i}`,
    categoryId: 'c-fruit',
    categoryName: 'Fruit',
    barcode: null,
    buyPrice: '1.00',
    sellPrice: '2.00',
    taxRate: '0.00',
    warrantyMonths: 0,
    reorderLevel: 0,
    onHand: 5,
    ...overrides,
  };
}

function pageOf(rows: readonly ProductDTO[]): ListResponse<ProductDTO> {
  return { rows, nextCursor: null };
}

// ---------------------------------------------------------------------------
// API stub builder
// ---------------------------------------------------------------------------

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly productsList: MockInstance;
  readonly productsCount: MockInstance;
  readonly categoriesList: MockInstance;
}

function buildStub(rows: readonly ProductDTO[]): BuiltStub {
  const productsList = vi.fn(
    (): Promise<Result<ListResponse<ProductDTO>>> => Promise.resolve(Ok(pageOf(rows))),
  );
  const productsCount = vi.fn(() => Promise.resolve(Ok({ totalCount: rows.length })));
  const categoriesList = vi.fn(() => Promise.resolve(Ok({ rows: categories })));

  const stub: Partial<Api> = {
    'products:list': productsList,
    'products:count': productsCount,
    'categories:list': categoriesList,
  };
  return {
    stub,
    productsList,
    productsCount,
    categoriesList,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<ProductsListPage /> — rendering', () => {
  it('renders rows returned by products:list', async () => {
    const rows = [makeProduct(1), makeProduct(2), makeProduct(3)];
    const built = buildStub(rows);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <ProductsListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('products-row-p-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('products-row-p-2')).toBeInTheDocument();
    expect(screen.getByTestId('products-row-p-3')).toBeInTheDocument();
  });
});

describe('<ProductsListPage /> — role gating', () => {
  it('shows the New product button to Admins', () => {
    const built = buildStub([makeProduct(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <ProductsListPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('products-new-button')).toBeInTheDocument();
  });

  it('hides the New product button from Cashiers', async () => {
    const built = buildStub([makeProduct(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={cashierSession}>
        <ProductsListPage />
      </AuthProvider>,
    );

    expect(screen.queryByTestId('products-new-button')).not.toBeInTheDocument();

    // Wait for at least one row, then assert it carries no clickable
    // role — Cashiers see a read-only list.
    await waitFor(() => {
      expect(screen.getByTestId('products-row-p-1')).toBeInTheDocument();
    });
    const row = screen.getByTestId('products-row-p-1');
    expect(row).not.toHaveAttribute('role', 'button');
  });
});

describe('<ProductsListPage /> — search debouncing', () => {
  it('forwards the search input to products:list after the debounce window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const built = buildStub([makeProduct(1)]);
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <AuthProvider initialSession={adminSession}>
        <ProductsListPage />
      </AuthProvider>,
    );

    // First render fires the initial empty-search request.
    await vi.waitFor(() => {
      expect(built.productsList).toHaveBeenCalled();
    });
    const initialCalls = built.productsList.mock.calls.length;

    // Type a query. Debounce window is 250 ms.
    await user.type(screen.getByLabelText(/search/i), 'apple');

    // No new request inside the debounce window.
    expect(built.productsList.mock.calls.length).toBe(initialCalls);

    // Advance past the debounce window.
    await vi.advanceTimersByTimeAsync(300);

    await vi.waitFor(() => {
      expect(built.productsList.mock.calls.length).toBeGreaterThan(initialCalls);
    });

    const lastCall = built.productsList.mock.calls.at(-1)?.[0] as
      | { search?: string; cursor?: string }
      | undefined;
    expect(lastCall?.search).toBe('apple');
    // Filter / search change resets the cursor — the latest request
    // must not carry one.
    expect(lastCall?.cursor).toBeUndefined();
  });
});

describe('<ProductsListPage /> — filter changes reset the cursor', () => {
  it('issues a fresh first-page request when the category filter changes', async () => {
    const built = buildStub([makeProduct(1)]);
    installApi(built.stub);

    const user = userEvent.setup();

    render(
      <AuthProvider initialSession={adminSession}>
        <ProductsListPage />
      </AuthProvider>,
    );

    // Wait for the initial fetch + the categories dropdown to populate.
    await waitFor(() => {
      expect(built.productsList).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Fruit' })).toBeInTheDocument();
    });

    const callsBefore = built.productsList.mock.calls.length;
    await user.selectOptions(screen.getByLabelText(/category/i), 'c-veg');

    await waitFor(() => {
      expect(built.productsList.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    const lastReq = built.productsList.mock.calls.at(-1)?.[0] as
      | { filter?: { categoryId?: string }; cursor?: string }
      | undefined;
    expect(lastReq?.filter?.categoryId).toBe('c-veg');
    // Cursor was reset.
    expect(lastReq?.cursor).toBeUndefined();
  });
});

describe('<ProductsListPage /> — low stock filter', () => {
  it('forwards filter.lowStockOnly: true when checkbox is toggled', async () => {
    const built = buildStub([makeProduct(1)]);
    installApi(built.stub);

    const user = userEvent.setup();

    render(
      <AuthProvider initialSession={adminSession}>
        <ProductsListPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.productsList).toHaveBeenCalled();
    });

    const callsBefore = built.productsList.mock.calls.length;
    await user.click(screen.getByLabelText(/low stock only/i));

    await waitFor(() => {
      expect(built.productsList.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    const lastReq = built.productsList.mock.calls.at(-1)?.[0] as
      | { filter?: { lowStockOnly?: boolean } }
      | undefined;
    expect(lastReq?.filter?.lowStockOnly).toBe(true);
  });
});
