/**
 * Unit tests for the purchase create page (task 6.3, Phase 6).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by `AdjustPage.test.tsx` and
 * `SupplierFormPage.test.tsx`.
 *
 * Coverage:
 *   - Empty form keeps Submit disabled.
 *   - Supplier picker populates from a mocked `suppliers:list`.
 *   - Adding two product lines updates the per-line totals + grand
 *     total.
 *   - Submit calls `purchase:create` with the exact wire shape.
 *   - `VALIDATION { field: 'items[1].quantity' }` highlights the
 *     second line's quantity input.
 *   - `FK_VIOLATION` renders the "supplier or product not found"
 *     copy.
 *   - Successful submit clears the form and renders the success
 *     banner.
 *
 * Validates: Requirements 5.1, 5.2, 5.3.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PurchaseCreatePage } from '@renderer/features/purchases/PurchaseCreatePage';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type {
  ProductDTO,
  PurchaseInput,
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSupplier(i: number, overrides: Partial<SupplierDTO> = {}): SupplierDTO {
  return {
    id: `sup-${String(i)}`,
    name: `Supplier ${String(i)}`,
    phone: '555-0',
    address: '1 Way',
    ...overrides,
  };
}

function makeProduct(i: number, overrides: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: `p-${String(i)}`,
    sku: `SKU-${String(i)}`,
    name: `Product ${String(i)}`,
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

function pageOf<T>(rows: readonly T[]): ListResponse<T> {
  return { rows, nextCursor: null };
}

// ---------------------------------------------------------------------------
// API stub builder
// ---------------------------------------------------------------------------

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly suppliersList: ReturnType<typeof vi.fn>;
  readonly productsList: ReturnType<typeof vi.fn>;
  readonly purchaseCreate: ReturnType<typeof vi.fn>;
}

function buildStub(opts: {
  suppliers?: readonly SupplierDTO[];
  products?: readonly ProductDTO[];
  purchaseCreate?: ReturnType<typeof vi.fn>;
}): BuiltStub {
  const suppliersList = vi.fn(() =>
    Promise.resolve(Ok(pageOf(opts.suppliers ?? []))),
  );
  const productsList = vi.fn(() =>
    Promise.resolve(Ok(pageOf(opts.products ?? []))),
  );
  const purchaseCreate =
    opts.purchaseCreate ??
    vi.fn(() => Promise.resolve(Ok({ purchaseId: 'pur-1' })));

  const stub: Partial<Api> = {
    'suppliers:list': suppliersList,
    'products:list': productsList,
    'purchase:create': purchaseCreate,
  };
  return { stub, suppliersList, productsList, purchaseCreate };
}

// ---------------------------------------------------------------------------
// Page interaction helpers
// ---------------------------------------------------------------------------

/**
 * Run the supplier typeahead through the debounce window and click
 * the picked supplier's result button. Centralized so each test does
 * not reinvent the user flow.
 */
async function pickSupplier(opts: {
  user: ReturnType<typeof userEvent.setup>;
  supplier: SupplierDTO;
}): Promise<void> {
  await opts.user.type(
    screen.getByTestId('purchase-create-supplier-search'),
    opts.supplier.name,
  );
  await vi.advanceTimersByTimeAsync(300);
  await waitFor(() => {
    expect(
      screen.getByTestId(`purchase-create-supplier-result-${opts.supplier.id}`),
    ).toBeInTheDocument();
  });
  await opts.user.click(
    screen.getByTestId(`purchase-create-supplier-result-${opts.supplier.id}`),
  );
  await waitFor(() => {
    expect(screen.getByTestId('purchase-create-supplier-selected')).toBeInTheDocument();
  });
}

/**
 * Pick a product into a specific line's typeahead. Assumes the line
 * already exists.
 */
async function pickLineProduct(opts: {
  user: ReturnType<typeof userEvent.setup>;
  index: number;
  product: ProductDTO;
}): Promise<void> {
  const search = screen.getByTestId(
    `purchase-create-line-${String(opts.index)}-product-search`,
  );
  await opts.user.type(search, opts.product.name);
  await vi.advanceTimersByTimeAsync(300);
  await waitFor(() => {
    expect(
      screen.getByTestId(
        `purchase-create-line-${String(opts.index)}-product-result-${opts.product.id}`,
      ),
    ).toBeInTheDocument();
  });
  await opts.user.click(
    screen.getByTestId(
      `purchase-create-line-${String(opts.index)}-product-result-${opts.product.id}`,
    ),
  );
  await waitFor(() => {
    expect(
      screen.getByTestId(
        `purchase-create-line-${String(opts.index)}-product-selected`,
      ),
    ).toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------
// Tests — submit gating
// ---------------------------------------------------------------------------

describe('<PurchaseCreatePage /> — initial state', () => {
  it('keeps the Submit button disabled on an empty form', () => {
    const built = buildStub({});
    installApi(built.stub);

    render(<PurchaseCreatePage />);

    expect(screen.getByTestId('purchase-create-submit')).toBeDisabled();
    // No lines yet → empty-state placeholder is visible.
    expect(screen.getByTestId('purchase-create-no-lines')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — supplier picker
// ---------------------------------------------------------------------------

describe('<PurchaseCreatePage /> — supplier picker', () => {
  it('populates the dropdown from suppliers:list after the debounce window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const supplier = makeSupplier(1, { name: 'Acme Tools' });
    const built = buildStub({ suppliers: [supplier] });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PurchaseCreatePage />);

    await user.type(
      screen.getByTestId('purchase-create-supplier-search'),
      'Acme',
    );
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

    // Result row is rendered and selectable.
    await waitFor(() => {
      expect(
        screen.getByTestId(`purchase-create-supplier-result-${supplier.id}`),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByTestId(`purchase-create-supplier-result-${supplier.id}`),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('purchase-create-supplier-selected-name'),
      ).toHaveTextContent('Acme Tools');
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — line totals and grand total
// ---------------------------------------------------------------------------

describe('<PurchaseCreatePage /> — line totals', () => {
  it('updates per-line totals and the grand total as lines are added', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const supplier = makeSupplier(1);
    const productA = makeProduct(1, { name: 'Hammer', sku: 'HW-1' });
    const productB = makeProduct(2, { name: 'Nails', sku: 'HW-2' });
    const built = buildStub({
      suppliers: [supplier],
      products: [productA, productB],
    });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PurchaseCreatePage />);

    await pickSupplier({ user, supplier });

    // Add first line: 2 × 10.50 = 21.00
    await user.click(screen.getByTestId('purchase-create-add-line'));
    await pickLineProduct({ user, index: 0, product: productA });
    await user.clear(screen.getByTestId('purchase-create-line-0-quantity'));
    await user.type(screen.getByTestId('purchase-create-line-0-quantity'), '2');
    await user.type(
      screen.getByTestId('purchase-create-line-0-unit-buy-price'),
      '10.50',
    );

    expect(
      screen.getByTestId('purchase-create-line-0-line-total'),
    ).toHaveTextContent('21.00');

    // Add second line: 3 × 4.25 = 12.75
    await user.click(screen.getByTestId('purchase-create-add-line'));
    await pickLineProduct({ user, index: 1, product: productB });
    await user.clear(screen.getByTestId('purchase-create-line-1-quantity'));
    await user.type(screen.getByTestId('purchase-create-line-1-quantity'), '3');
    await user.type(
      screen.getByTestId('purchase-create-line-1-unit-buy-price'),
      '4.25',
    );

    expect(
      screen.getByTestId('purchase-create-line-1-line-total'),
    ).toHaveTextContent('12.75');

    // Grand total = 21.00 + 12.75 = 33.75
    expect(screen.getByTestId('purchase-create-grand-total')).toHaveTextContent(
      '33.75',
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — successful submit
// ---------------------------------------------------------------------------

describe('<PurchaseCreatePage /> — successful submit', () => {
  it('forwards the exact wire shape to purchase:create and clears the form on success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const supplier = makeSupplier(7, { name: 'Acme' });
    const productA = makeProduct(1);
    const productB = makeProduct(2);
    const purchaseCreate = vi.fn(() =>
      Promise.resolve(Ok({ purchaseId: 'pur-42' })),
    );
    const built = buildStub({
      suppliers: [supplier],
      products: [productA, productB],
      purchaseCreate,
    });
    installApi(built.stub);

    const onCreated = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PurchaseCreatePage onCreated={onCreated} />);

    await pickSupplier({ user, supplier });
    await user.type(
      screen.getByTestId('purchase-create-invoice-no'),
      'INV-001',
    );

    // Line 1: 2 × 10.50
    await user.click(screen.getByTestId('purchase-create-add-line'));
    await pickLineProduct({ user, index: 0, product: productA });
    await user.clear(screen.getByTestId('purchase-create-line-0-quantity'));
    await user.type(screen.getByTestId('purchase-create-line-0-quantity'), '2');
    await user.type(
      screen.getByTestId('purchase-create-line-0-unit-buy-price'),
      '10.50',
    );

    // Line 2: 3 × 4.25
    await user.click(screen.getByTestId('purchase-create-add-line'));
    await pickLineProduct({ user, index: 1, product: productB });
    await user.clear(screen.getByTestId('purchase-create-line-1-quantity'));
    await user.type(screen.getByTestId('purchase-create-line-1-quantity'), '3');
    await user.type(
      screen.getByTestId('purchase-create-line-1-unit-buy-price'),
      '4.25',
    );

    expect(screen.getByTestId('purchase-create-submit')).not.toBeDisabled();

    await user.click(screen.getByTestId('purchase-create-submit'));

    await waitFor(() => {
      expect(purchaseCreate).toHaveBeenCalledTimes(1);
    });

    const payload = purchaseCreate.mock.calls[0]?.[0] as PurchaseInput | undefined;
    expect(payload).toEqual({
      supplierId: supplier.id,
      invoiceNo: 'INV-001',
      items: [
        { productId: productA.id, quantity: 2, unitBuyPrice: '10.50' },
        { productId: productB.id, quantity: 3, unitBuyPrice: '4.25' },
      ],
    });

    // Form clears.
    await waitFor(() => {
      expect(
        screen.queryByTestId('purchase-create-supplier-selected'),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('purchase-create-invoice-no')).toHaveValue('');
    expect(screen.getByTestId('purchase-create-no-lines')).toBeInTheDocument();

    // Success banner carries the new purchaseId.
    expect(screen.getByTestId('purchase-create-success')).toBeInTheDocument();
    expect(screen.getByTestId('purchase-create-success-id')).toHaveTextContent(
      'pur-42',
    );
    expect(onCreated).toHaveBeenCalledWith('pur-42');
  });

  it("forwards invoiceNo: null on the wire when the field is left empty", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const supplier = makeSupplier(1);
    const product = makeProduct(1);
    const purchaseCreate = vi.fn(() =>
      Promise.resolve(Ok({ purchaseId: 'pur-1' })),
    );
    const built = buildStub({
      suppliers: [supplier],
      products: [product],
      purchaseCreate,
    });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PurchaseCreatePage />);

    await pickSupplier({ user, supplier });
    await user.click(screen.getByTestId('purchase-create-add-line'));
    await pickLineProduct({ user, index: 0, product });
    await user.type(
      screen.getByTestId('purchase-create-line-0-unit-buy-price'),
      '1.00',
    );

    await user.click(screen.getByTestId('purchase-create-submit'));

    await waitFor(() => {
      expect(purchaseCreate).toHaveBeenCalled();
    });
    const payload = purchaseCreate.mock.calls[0]?.[0] as PurchaseInput | undefined;
    expect(payload?.invoiceNo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — server error mapping
// ---------------------------------------------------------------------------

describe('<PurchaseCreatePage /> — server error mapping', () => {
  it('highlights the second line\'s quantity input on VALIDATION { field: "items[1].quantity" }', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const supplier = makeSupplier(1);
    const productA = makeProduct(1);
    const productB = makeProduct(2);
    const purchaseCreate = vi.fn(() =>
      Promise.resolve(Err('VALIDATION', { field: 'items[1].quantity' })),
    );
    const built = buildStub({
      suppliers: [supplier],
      products: [productA, productB],
      purchaseCreate,
    });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PurchaseCreatePage />);

    await pickSupplier({ user, supplier });

    await user.click(screen.getByTestId('purchase-create-add-line'));
    await pickLineProduct({ user, index: 0, product: productA });
    await user.type(
      screen.getByTestId('purchase-create-line-0-unit-buy-price'),
      '1.00',
    );

    await user.click(screen.getByTestId('purchase-create-add-line'));
    await pickLineProduct({ user, index: 1, product: productB });
    await user.type(
      screen.getByTestId('purchase-create-line-1-unit-buy-price'),
      '2.00',
    );

    await user.click(screen.getByTestId('purchase-create-submit'));

    await waitFor(() => {
      expect(purchaseCreate).toHaveBeenCalled();
    });

    // Second line's quantity input is marked invalid.
    const secondQty = screen.getByTestId('purchase-create-line-1-quantity');
    await waitFor(() => {
      expect(secondQty).toHaveAttribute('aria-invalid', 'true');
    });

    // First line's quantity is NOT marked invalid by the server error.
    const firstQty = screen.getByTestId('purchase-create-line-0-quantity');
    expect(firstQty.getAttribute('aria-invalid')).not.toBe('true');

    // No FK_VIOLATION copy should be on screen.
    expect(
      screen.queryByText(/supplier or product not found/i),
    ).not.toBeInTheDocument();
  });

  it('renders "supplier or product not found" on FK_VIOLATION', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const supplier = makeSupplier(1);
    const product = makeProduct(1);
    const purchaseCreate = vi.fn(() =>
      Promise.resolve(Err('FK_VIOLATION', { reason: 'not_found' })),
    );
    const built = buildStub({
      suppliers: [supplier],
      products: [product],
      purchaseCreate,
    });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PurchaseCreatePage />);

    await pickSupplier({ user, supplier });
    await user.click(screen.getByTestId('purchase-create-add-line'));
    await pickLineProduct({ user, index: 0, product });
    await user.type(
      screen.getByTestId('purchase-create-line-0-unit-buy-price'),
      '1.00',
    );

    await user.click(screen.getByTestId('purchase-create-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('purchase-create-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('purchase-create-banner')).toHaveTextContent(
      /supplier or product not found/i,
    );
  });

  it('renders a generic banner with code + message on other envelopes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const supplier = makeSupplier(1);
    const product = makeProduct(1);
    const purchaseCreate = vi.fn(() =>
      Promise.resolve(Err('INTERNAL', undefined, { errorId: 'eid-1' })),
    );
    const built = buildStub({
      suppliers: [supplier],
      products: [product],
      purchaseCreate,
    });
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PurchaseCreatePage />);

    await pickSupplier({ user, supplier });
    await user.click(screen.getByTestId('purchase-create-add-line'));
    await pickLineProduct({ user, index: 0, product });
    await user.type(
      screen.getByTestId('purchase-create-line-0-unit-buy-price'),
      '1.00',
    );

    await user.click(screen.getByTestId('purchase-create-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('purchase-create-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('purchase-create-banner')).toHaveTextContent(
      'INTERNAL',
    );
  });
});
