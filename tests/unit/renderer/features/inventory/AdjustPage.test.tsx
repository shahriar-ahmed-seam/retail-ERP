/**
 * Unit tests for the manual stock adjustment page (task 5.4).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by `ProductFormPage.test.tsx` and
 * `ProductsListPage.test.tsx`.
 *
 * Coverage:
 *   - Form renders the typeahead, delta, and reason fields for Admin.
 *   - Cashier sees the permission-denied surface instead of the form.
 *   - Submit calls `inventory:adjust` with the correct payload.
 *   - `OUT_OF_STOCK` envelope renders inline near the delta input.
 *   - `VALIDATION { field: 'reason' }` renders inline next to that
 *     input.
 *   - Successful submit clears the form fields.
 *
 * Validates: Requirements 3.5, 8.2, 13.3.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdjustPage } from '@renderer/features/inventory/AdjustPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { AdjustmentInput, ProductDTO } from '@shared/dto/index';
import type { ListResponse, SessionDTO } from '@shared/ipc-contract';

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
  readonly productsList: ReturnType<typeof vi.fn>;
  readonly inventoryAdjust: ReturnType<typeof vi.fn>;
}

function buildStub(opts: {
  rows: readonly ProductDTO[];
  adjust?: ReturnType<typeof vi.fn>;
}): BuiltStub {
  const productsList = vi.fn(() => Promise.resolve(Ok(pageOf(opts.rows))));
  const inventoryAdjust =
    opts.adjust ?? vi.fn(() => Promise.resolve(Ok({ movementId: 'mov-1' })));

  const stub: Partial<Api> = {
    'products:list': productsList,
    'inventory:adjust': inventoryAdjust,
  };

  return { stub, productsList, inventoryAdjust };
}

/**
 * Pick a product through the typeahead. Centralized so each test does
 * not reinvent the user flow. Uses fake timers to advance past the
 * 250 ms search debounce.
 */
async function pickProduct(opts: {
  user: ReturnType<typeof userEvent.setup>;
  product: ProductDTO;
}): Promise<void> {
  await opts.user.type(screen.getByTestId('adjust-product-search'), opts.product.name);
  await vi.advanceTimersByTimeAsync(300);

  await waitFor(() => {
    expect(
      screen.getByTestId(`adjust-product-result-${opts.product.id}`),
    ).toBeInTheDocument();
  });

  await opts.user.click(screen.getByTestId(`adjust-product-result-${opts.product.id}`));

  await waitFor(() => {
    expect(screen.getByTestId('adjust-selected-product')).toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<AdjustPage /> — role gating', () => {
  it('renders the form for Admins', () => {
    const built = buildStub({ rows: [makeProduct(1)] });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <AdjustPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('adjust-product-search')).toBeInTheDocument();
    expect(screen.getByTestId('adjust-delta')).toBeInTheDocument();
    expect(screen.getByTestId('adjust-reason')).toBeInTheDocument();
    expect(screen.getByTestId('adjust-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('adjust-permission-denied')).not.toBeInTheDocument();
  });

  it('shows a permission-denied surface for Cashiers', () => {
    const built = buildStub({ rows: [makeProduct(1)] });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={cashierSession}>
        <AdjustPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('adjust-permission-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('adjust-product-search')).not.toBeInTheDocument();
    expect(screen.queryByTestId('adjust-submit')).not.toBeInTheDocument();
  });

  it('shows a permission-denied surface for unauthenticated users', () => {
    const built = buildStub({ rows: [] });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={null}>
        <AdjustPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('adjust-permission-denied')).toBeInTheDocument();
  });
});

describe('<AdjustPage /> — successful submit', () => {
  it('calls inventory:adjust with the correct payload and clears the form', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const product = makeProduct(7, { name: 'Hammer', sku: 'HW-7', onHand: 4 });
    const adjust = vi.fn(() => Promise.resolve(Ok({ movementId: 'mov-42' })));
    const built = buildStub({ rows: [product], adjust });
    installApi(built.stub);

    const onAdjusted = vi.fn();

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <AuthProvider initialSession={adminSession}>
        <AdjustPage onAdjusted={onAdjusted} />
      </AuthProvider>,
    );

    await pickProduct({ user, product });

    await user.type(screen.getByTestId('adjust-delta'), '3');
    await user.type(screen.getByTestId('adjust-reason'), 'Recount after audit');

    await user.click(screen.getByTestId('adjust-submit'));

    await waitFor(() => {
      expect(adjust).toHaveBeenCalledTimes(1);
    });

    const payload = adjust.mock.calls[0]?.[0] as AdjustmentInput | undefined;
    expect(payload).toEqual({
      productId: 'p-7',
      quantityDelta: 3,
      reason: 'Recount after audit',
    });

    // Form clears after success.
    await waitFor(() => {
      expect(screen.queryByTestId('adjust-selected-product')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('adjust-delta')).toHaveValue('');
    expect(screen.getByTestId('adjust-reason')).toHaveValue('');

    // Success indicator + parent callback both fire.
    expect(screen.getByTestId('adjust-success')).toBeInTheDocument();
    expect(screen.getByTestId('adjust-success')).toHaveTextContent('mov-42');
    expect(onAdjusted).toHaveBeenCalledWith('mov-42');
  });

  it('forwards a negative delta verbatim', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const product = makeProduct(2, { onHand: 10 });
    const adjust = vi.fn(() => Promise.resolve(Ok({ movementId: 'mov-2' })));
    const built = buildStub({ rows: [product], adjust });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <AuthProvider initialSession={adminSession}>
        <AdjustPage />
      </AuthProvider>,
    );

    await pickProduct({ user, product });

    await user.type(screen.getByTestId('adjust-delta'), '-2');
    await user.type(screen.getByTestId('adjust-reason'), 'Damaged stock');

    await user.click(screen.getByTestId('adjust-submit'));

    await waitFor(() => {
      expect(adjust).toHaveBeenCalled();
    });

    const payload = adjust.mock.calls[0]?.[0] as AdjustmentInput | undefined;
    expect(payload?.quantityDelta).toBe(-2);
  });
});

describe('<AdjustPage /> — server error mapping', () => {
  it('renders OUT_OF_STOCK inline near the delta input', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const product = makeProduct(3, { onHand: 1 });
    const adjust = vi.fn(() =>
      Promise.resolve(Err('OUT_OF_STOCK', { productId: 'p-3' })),
    );
    const built = buildStub({ rows: [product], adjust });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <AuthProvider initialSession={adminSession}>
        <AdjustPage />
      </AuthProvider>,
    );

    await pickProduct({ user, product });
    await user.type(screen.getByTestId('adjust-delta'), '-5');
    await user.type(screen.getByTestId('adjust-reason'), 'Bad math');

    await user.click(screen.getByTestId('adjust-submit'));

    await waitFor(() => {
      expect(adjust).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId('adjust-out-of-stock-error')).toBeInTheDocument();
    });

    // Delta input is marked invalid and connected to the error.
    const deltaInput = screen.getByTestId('adjust-delta');
    expect(deltaInput).toHaveAttribute('aria-invalid', 'true');
    expect(deltaInput.getAttribute('aria-describedby')).toBeTruthy();

    // Generic banner does not appear for code-mapped envelopes.
    expect(screen.queryByTestId('adjust-banner')).not.toBeInTheDocument();
  });

  it('renders VALIDATION { field: "reason" } inline next to the reason input', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const product = makeProduct(4);
    const adjust = vi.fn(() =>
      Promise.resolve(Err('VALIDATION', { field: 'reason' })),
    );
    const built = buildStub({ rows: [product], adjust });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <AuthProvider initialSession={adminSession}>
        <AdjustPage />
      </AuthProvider>,
    );

    await pickProduct({ user, product });
    await user.type(screen.getByTestId('adjust-delta'), '2');
    // Type a reason long enough to satisfy the client-side gate so
    // submit fires; the server returns VALIDATION anyway in this test.
    await user.type(screen.getByTestId('adjust-reason'), 'reason text');

    await user.click(screen.getByTestId('adjust-submit'));

    await waitFor(() => {
      expect(adjust).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId('adjust-reason-error')).toBeInTheDocument();
    });

    const reasonInput = screen.getByTestId('adjust-reason');
    expect(reasonInput).toHaveAttribute('aria-invalid', 'true');
    const describedBy = reasonInput.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const errorEl = document.getElementById(describedBy ?? '');
    expect(errorEl).not.toBeNull();
  });
});

describe('<AdjustPage /> — submit gating', () => {
  it('keeps submit disabled until product, delta, and reason are valid', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const product = makeProduct(5);
    const built = buildStub({ rows: [product] });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <AuthProvider initialSession={adminSession}>
        <AdjustPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('adjust-submit')).toBeDisabled();

    await pickProduct({ user, product });
    expect(screen.getByTestId('adjust-submit')).toBeDisabled();

    await user.type(screen.getByTestId('adjust-delta'), '0');
    // Zero delta is rejected client-side.
    expect(screen.getByTestId('adjust-submit')).toBeDisabled();

    await user.clear(screen.getByTestId('adjust-delta'));
    await user.type(screen.getByTestId('adjust-delta'), '4');
    expect(screen.getByTestId('adjust-submit')).toBeDisabled();

    await user.type(screen.getByTestId('adjust-reason'), 'Stock count');
    expect(screen.getByTestId('adjust-submit')).not.toBeDisabled();
  });
});
