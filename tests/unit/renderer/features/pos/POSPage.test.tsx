/**
 * Unit tests for the POS single-screen page (tasks 7.5 + 7.6).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by `PurchaseCreatePage.test.tsx` and
 * `AdjustPage.test.tsx`.
 *
 * The page's primary input is a typeahead-driven product search that
 * calls `products:list`. A barcode-scanner fallback stays wired to
 * the same input — when the typed value is alphanumeric and at least
 * four characters long AND the typeahead returns no live matches,
 * pressing Enter falls through to `pos:scan`. The scanner-flow tests
 * below intentionally type alphanumeric barcodes against a stub
 * whose `products:list` returns an empty page so the fallback path
 * fires; the typeahead-flow tests stub `products:list` with the
 * fixtures the cashier should see in the dropdown.
 *
 * Coverage:
 *   - Empty cart keeps Finalize disabled.
 *   - Scanner fallback: barcode Enter → `pos:scan` → cart row appears.
 *   - Scanner fallback: same barcode twice → quantity becomes 2.
 *   - Typeahead: typing fires `products:list` with the search term.
 *   - Typeahead: clicking a row adds the product with quantity 1.
 *   - Typeahead: ArrowDown highlights, Enter on highlighted adds.
 *   - Typeahead: empty results render the "No products match" copy.
 *   - Typeahead: Escape closes the dropdown without adding.
 *   - Edit quantity → totals update.
 *   - Apply 10% discount → discount + grand total update; tax computed
 *     on post-discount subtotal.
 *   - Apply fixed discount > subtotal → clamped to subtotal.
 *   - Add cash payment matching grand total → Finalize enabled.
 *   - Add cash payment less than grand total → Finalize disabled,
 *     remaining balance shows the difference.
 *   - Submit calls `pos:finalize` with the exact wire shape (totals
 *     match the live values).
 *   - Successful submit clears the cart and renders the success
 *     banner with the serial number.
 *   - `OUT_OF_STOCK` envelope marks the offending line, cart preserved,
 *     Finalize disabled.
 *   - `VALIDATION` envelope renders a banner with the field name.
 *   - `FK_VIOLATION` envelope renders the "customer or product not
 *     found" copy.
 *
 * Validates: Requirements 4.1, 4.4, 4.5, 4.6, 7.4, 14.3.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Decimal from 'decimal.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POSPage } from '@renderer/features/pos/POSPage';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type {
  CustomerDTO,
  FinalizeSaleInput,
  ProductDTO,
  SaleDTO,
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

function makeProduct(i: number, overrides: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: `p-${String(i)}`,
    sku: `SKU-${String(i)}`,
    name: `Product ${String(i)}`,
    categoryId: 'c-fruit',
    categoryName: 'Fruit',
    barcode: `BCBC${String(i)}`,
    buyPrice: '5.00',
    sellPrice: '10.00',
    taxRate: '0.10',
    warrantyMonths: 0,
    reorderLevel: 0,
    onHand: 5,
    ...overrides,
  };
}

function makeSaleDTO(overrides: Partial<SaleDTO> = {}): SaleDTO {
  return {
    id: 'sale-1',
    serialNo: 'INV-000001',
    customerId: null,
    customerName: null,
    cashierId: 'u-1',
    cashierName: 'cashier',
    subtotal: '0',
    discount: '0',
    taxTotal: '0',
    grandTotal: '0',
    createdAt: '2026-05-24T12:00:00.000Z',
    items: [],
    payments: [],
    ...overrides,
  };
}

function pageOf<T>(rows: readonly T[]): ListResponse<T> {
  return { rows, nextCursor: null };
}

function makeCustomer(
  overrides: Partial<CustomerDTO> = {},
): CustomerDTO {
  return {
    id: 'c-1',
    name: 'Acme Walk-in',
    phone: '555-0100',
    createdAt: '2026-05-24T12:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// API stub builder
// ---------------------------------------------------------------------------

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly posScan: ReturnType<typeof vi.fn>;
  readonly posFinalize: ReturnType<typeof vi.fn>;
  readonly customersList: ReturnType<typeof vi.fn>;
  readonly customersUpsert: ReturnType<typeof vi.fn>;
  readonly productsList: ReturnType<typeof vi.fn>;
}

function buildStub(opts: {
  scanByBarcode?: Readonly<Record<string, ProductDTO | null>>;
  finalize?: ReturnType<typeof vi.fn>;
  customers?: readonly CustomerDTO[];
  customersUpsert?: ReturnType<typeof vi.fn>;
  /**
   * Stubbed return value for `products:list`. The page uses
   * `products:list` for the search-typeahead dropdown. Defaults to
   * an empty page so the barcode-scanner fallback path fires when
   * the test types an alphanumeric value and presses Enter.
   */
  searchProducts?: readonly ProductDTO[];
  /**
   * Override the entire `products:list` mock when a test needs to
   * assert on the request payload or simulate an error envelope.
   */
  productsList?: ReturnType<typeof vi.fn>;
}): BuiltStub {
  const map = opts.scanByBarcode ?? {};
  const posScan = vi.fn((req: { barcode: string }) => {
    const found = map[req.barcode];
    if (found === undefined) {
      return Promise.resolve(Ok(null));
    }
    return Promise.resolve(Ok(found));
  });

  const posFinalize =
    opts.finalize ??
    vi.fn(() =>
      Promise.resolve(
        Ok({
          saleId: 'sale-1',
          serialNo: 'INV-000001',
          sale: makeSaleDTO(),
        }),
      ),
    );

  const customersList = vi.fn(() =>
    Promise.resolve(Ok(pageOf(opts.customers ?? []))),
  );

  const customersUpsert =
    opts.customersUpsert ??
    vi.fn(() => Promise.resolve(Ok(makeCustomer())));

  const productsList =
    opts.productsList ??
    vi.fn(() => Promise.resolve(Ok(pageOf(opts.searchProducts ?? []))));

  const stub: Partial<Api> = {
    'pos:scan': posScan,
    'pos:finalize': posFinalize,
    'customers:list': customersList,
    'customers:upsert': customersUpsert,
    'products:list': productsList,
  };
  return {
    stub,
    posScan,
    posFinalize,
    customersList,
    customersUpsert,
    productsList,
  };
}

// ---------------------------------------------------------------------------
// Interaction helpers
// ---------------------------------------------------------------------------

/**
 * Simulate a barcode scan via the keyboard-driven Enter path. Uses the
 * page's form submit so the scan settle effect doesn't race with the
 * test (the Enter path is synchronous from the input's POV).
 */
async function scanBarcode(opts: {
  user: ReturnType<typeof userEvent.setup>;
  barcode: string;
}): Promise<void> {
  const input = screen.getByTestId('pos-product-search');
  await opts.user.clear(input);
  await opts.user.type(input, `${opts.barcode}{Enter}`);
}

// ---------------------------------------------------------------------------
// Tests — initial state
// ---------------------------------------------------------------------------

describe('<POSPage /> — initial state', () => {
  it('keeps Finalize disabled on an empty cart', () => {
    const built = buildStub({});
    installApi(built.stub);

    render(<POSPage />);

    expect(screen.getByTestId('pos-finalize')).toBeDisabled();
    expect(screen.getByTestId('pos-cart-empty')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — scanner fallback
// ---------------------------------------------------------------------------

describe('<POSPage /> — scanner fallback', () => {
  it('appends a cart row with quantity 1 on a successful scan', async () => {
    const product = makeProduct(1, { barcode: 'BCBC1' });
    const built = buildStub({ scanByBarcode: { 'BCBC1': product } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });

    await waitFor(() => {
      expect(built.posScan).toHaveBeenCalledWith({ barcode: 'BCBC1' });
    });

    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-cart-row-${product.id}`),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`pos-cart-row-${product.id}-quantity`),
    ).toHaveValue('1');
  });

  it('increments quantity when the same product is scanned twice', async () => {
    const product = makeProduct(1, { barcode: 'BCBC1' });
    const built = buildStub({ scanByBarcode: { 'BCBC1': product } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-cart-row-${product.id}-quantity`),
      ).toHaveValue('1');
    });

    await scanBarcode({ user, barcode: 'BCBC1' });

    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-cart-row-${product.id}-quantity`),
      ).toHaveValue('2');
    });
  });

  it('shows a "no product" message when the barcode does not match', async () => {
    const built = buildStub({});
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'UNKNOWN' });

    await waitFor(() => {
      expect(screen.getByTestId('pos-scan-message')).toHaveTextContent(
        /no product with barcode UNKNOWN/i,
      );
    });
    expect(screen.queryByTestId('pos-cart-empty')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — product search typeahead
// ---------------------------------------------------------------------------

describe('<POSPage /> — product search typeahead', () => {
  it('debounces typing into a single products:list call with the search term and pageSize 8', async () => {
    const widget = makeProduct(1, {
      id: 'p-widget',
      sku: 'SKU-WIDGET',
      name: 'Widget',
      barcode: null,
      sellPrice: '12.50',
    });
    const built = buildStub({ searchProducts: [widget] });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    const input = screen.getByTestId('pos-product-search');
    await user.type(input, 'wid');

    // The debounce window collapses the keystroke burst into a
    // single call.
    await waitFor(() => {
      expect(built.productsList).toHaveBeenCalled();
    });
    const call = built.productsList.mock.calls.at(-1);
    expect(call?.[0]).toEqual({ search: 'wid', pageSize: 8 });

    // The result row renders with name, SKU, sell price, and an
    // explicit "Add" affordance. The on-hand column is also wired.
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-product-search-result-${widget.id}`),
      ).toBeInTheDocument();
    });
    const row = screen.getByTestId(`pos-product-search-result-${widget.id}`);
    expect(row).toHaveTextContent('Widget');
    expect(row).toHaveTextContent('SKU-WIDGET');
    expect(row).toHaveTextContent('12.50');
    expect(
      screen.getByTestId(`pos-product-search-result-${widget.id}-add`),
    ).toBeInTheDocument();
  });

  it('clicking a result row adds the product to the cart with quantity 1', async () => {
    const widget = makeProduct(2, {
      id: 'p-widget',
      sku: 'SKU-WIDGET',
      name: 'Widget',
      barcode: null,
      sellPrice: '12.50',
      taxRate: '0.00',
    });
    const built = buildStub({ searchProducts: [widget] });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await user.type(screen.getByTestId('pos-product-search'), 'wid');
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-product-search-result-${widget.id}`),
      ).toBeInTheDocument();
    });

    // Use mouseDown via fireEvent semantics — the dropdown row uses
    // onMouseDown so the input doesn't blur out before the pick is
    // recorded. user.click drives a real mouse sequence including
    // mousedown so this is the same as the cashier clicking the row.
    await user.click(
      screen.getByTestId(`pos-product-search-result-${widget.id}`),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-cart-row-${widget.id}`),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`pos-cart-row-${widget.id}-quantity`),
    ).toHaveValue('1');

    // Dropdown closes and input clears.
    expect(
      screen.queryByTestId('pos-product-search-results'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('pos-product-search')).toHaveValue('');
  });

  it('ArrowDown highlights the next result; Enter on highlighted adds it', async () => {
    const a = makeProduct(1, {
      id: 'p-a',
      sku: 'SKU-A',
      name: 'Apple',
      barcode: null,
    });
    const b = makeProduct(2, {
      id: 'p-b',
      sku: 'SKU-B',
      name: 'Apricot',
      barcode: null,
    });
    const built = buildStub({ searchProducts: [a, b] });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await user.type(screen.getByTestId('pos-product-search'), 'ap');
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-product-search-result-${b.id}`),
      ).toBeInTheDocument();
    });

    // First row is auto-highlighted; ArrowDown moves to the second.
    await user.keyboard('{ArrowDown}');
    expect(
      screen.getByTestId(`pos-product-search-result-${b.id}`),
    ).toHaveAttribute('data-highlighted', 'true');

    // Enter picks the highlighted (second) row.
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId(`pos-cart-row-${b.id}`)).toBeInTheDocument();
    });
    // The first row should NOT have been added.
    expect(screen.queryByTestId(`pos-cart-row-${a.id}`)).not.toBeInTheDocument();
  });

  it('renders "No products match" when the search returns nothing', async () => {
    const built = buildStub({ searchProducts: [] });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    // Use a non-barcode-shape value (contains a space) so the
    // settle-delay scanner fallback never fires while we wait for
    // the empty-state copy to render.
    await user.type(screen.getByTestId('pos-product-search'), 'no match');
    await waitFor(() => {
      expect(built.productsList).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pos-product-search-empty')).toHaveTextContent(
        /no products match/i,
      );
    });
  });

  it('Escape closes the dropdown without adding to the cart', async () => {
    const widget = makeProduct(3, {
      id: 'p-widget',
      sku: 'SKU-WIDGET',
      name: 'Widget',
      barcode: null,
    });
    const built = buildStub({ searchProducts: [widget] });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await user.type(screen.getByTestId('pos-product-search'), 'wid');
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-product-search-result-${widget.id}`),
      ).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');

    expect(
      screen.queryByTestId('pos-product-search-results'),
    ).not.toBeInTheDocument();
    // No cart row was added.
    expect(
      screen.queryByTestId(`pos-cart-row-${widget.id}`),
    ).not.toBeInTheDocument();
  });

  it('Enter falls through to pos:scan when the search yields no match and the value matches the barcode shape', async () => {
    const product = makeProduct(7, { barcode: 'BCBC7' });
    const built = buildStub({
      // Empty search results so the dropdown never matches; the
      // Enter handler then hands off to the scanner fallback.
      searchProducts: [],
      scanByBarcode: { BCBC7: product },
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await user.type(screen.getByTestId('pos-product-search'), 'BCBC7{Enter}');

    await waitFor(() => {
      expect(built.posScan).toHaveBeenCalledWith({ barcode: 'BCBC7' });
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-cart-row-${product.id}`),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — totals
// ---------------------------------------------------------------------------

describe('<POSPage /> — totals', () => {
  it('updates totals when cart quantity is edited', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const built = buildStub({ scanByBarcode: { 'BCBC1': product } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });

    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-subtotal')).toHaveTextContent('10.00');
    });

    const qty = screen.getByTestId(`pos-cart-row-${product.id}-quantity`);
    await user.clear(qty);
    await user.type(qty, '4');

    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-subtotal')).toHaveTextContent('40.00');
    });
    expect(screen.getByTestId('pos-totals-grand')).toHaveTextContent('40.00');
  });

  it('applies a 10% discount and computes tax on the post-discount subtotal', async () => {
    // 1 × 100.00 @ 18% tax. 10% discount → discountAmount 10, taxableBase 90,
    // taxTotal 90 * 0.18 = 16.20, grand 90 + 16.20 = 106.20.
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '100.00',
      taxRate: '0.18',
    });
    const built = buildStub({ scanByBarcode: { 'BCBC1': product } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });

    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-subtotal')).toHaveTextContent('100.00');
    });

    await user.click(screen.getByTestId('pos-discount-kind-percent'));
    const percentInput = screen.getByTestId('pos-discount-percent');
    await user.clear(percentInput);
    await user.type(percentInput, '0.10');

    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-discount')).toHaveTextContent('10.00');
    });
    expect(screen.getByTestId('pos-totals-tax')).toHaveTextContent('16.20');
    expect(screen.getByTestId('pos-totals-grand')).toHaveTextContent('106.20');
  });

  it('clamps a fixed discount > subtotal to the subtotal', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '50.00',
      taxRate: '0.00',
    });
    const built = buildStub({ scanByBarcode: { 'BCBC1': product } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });

    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-subtotal')).toHaveTextContent('50.00');
    });

    const amount = screen.getByTestId('pos-discount-amount');
    await user.clear(amount);
    await user.type(amount, '999');

    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-discount')).toHaveTextContent('50.00');
    });
    expect(screen.getByTestId('pos-totals-grand')).toHaveTextContent('0.00');
  });
});

// ---------------------------------------------------------------------------
// Tests — payments + finalize gating
// ---------------------------------------------------------------------------

describe('<POSPage /> — payments', () => {
  it('keeps Finalize disabled when payment sum is below grand total', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '20.00',
      taxRate: '0.00',
    });
    const built = buildStub({ scanByBarcode: { 'BCBC1': product } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });
    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-grand')).toHaveTextContent('20.00');
    });

    // Add a cash payment, then edit it down to less than grand total.
    await user.click(screen.getByTestId('pos-payment-add-cash'));
    const list = screen.getByTestId('pos-payment-list');
    const amountInput = list.querySelector<HTMLInputElement>(
      'input[data-testid$="-amount"]',
    );
    expect(amountInput).not.toBeNull();
    if (amountInput === null) throw new Error('payment amount input missing');
    await user.clear(amountInput);
    await user.type(amountInput, '5');

    expect(screen.getByTestId('pos-finalize')).toBeDisabled();
    expect(screen.getByTestId('pos-payment-remaining')).toHaveTextContent('15.00');
  });

  it('enables Finalize once payments equal grand total', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '20.00',
      taxRate: '0.00',
    });
    const built = buildStub({ scanByBarcode: { 'BCBC1': product } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });
    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-grand')).toHaveTextContent('20.00');
    });

    // The "Add Cash" button pre-fills the running balance, so Finalize
    // becomes enabled immediately.
    await user.click(screen.getByTestId('pos-payment-add-cash'));

    await waitFor(() => {
      expect(screen.getByTestId('pos-finalize')).not.toBeDisabled();
    });
    expect(screen.getByTestId('pos-payment-remaining')).toHaveTextContent('0.00');
  });
});

// ---------------------------------------------------------------------------
// Tests — finalize wire shape + success
// ---------------------------------------------------------------------------

describe('<POSPage /> — successful finalize', () => {
  it('forwards the exact wire shape to pos:finalize and clears the cart on success', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const finalize = vi.fn(() =>
      Promise.resolve(
        Ok({
          saleId: 'sale-42',
          serialNo: 'INV-000042',
          sale: makeSaleDTO({ id: 'sale-42', serialNo: 'INV-000042' }),
        }),
      ),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      finalize,
    });
    installApi(built.stub);

    const onFinalized = vi.fn();
    const user = userEvent.setup();
    render(<POSPage onFinalized={onFinalized} />);

    // Build a cart with quantity 2.
    await scanBarcode({ user, barcode: 'BCBC1' });
    await scanBarcode({ user, barcode: 'BCBC1' });
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-cart-row-${product.id}-quantity`),
      ).toHaveValue('2');
    });
    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-grand')).toHaveTextContent('20.00');
    });

    await user.click(screen.getByTestId('pos-payment-add-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('pos-finalize')).not.toBeDisabled();
    });

    await user.click(screen.getByTestId('pos-finalize'));

    await waitFor(() => {
      expect(finalize).toHaveBeenCalledTimes(1);
    });

    const payload = finalize.mock.calls[0]?.[0] as
      | FinalizeSaleInput
      | undefined;
    expect(payload).not.toBeUndefined();
    if (payload === undefined) throw new Error('finalize payload missing');

    expect(payload.customerId).toBeNull();
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toEqual({
      productId: product.id,
      quantity: 2,
      unitPrice: '10.00',
      taxRate: '0.00',
      lineTotal: '20',
    });
    expect(payload.discount).toEqual({ kind: 'fixed', amount: '0' });

    // The renderer's totals must agree to the bit with the live values.
    expect(new Decimal(payload.subtotal).equals(new Decimal('20'))).toBe(true);
    expect(new Decimal(payload.discountAmount).equals(new Decimal('0'))).toBe(
      true,
    );
    expect(new Decimal(payload.taxTotal).equals(new Decimal('0'))).toBe(true);
    expect(new Decimal(payload.grandTotal).equals(new Decimal('20'))).toBe(true);

    expect(payload.payments).toHaveLength(1);
    expect(payload.payments[0]?.method).toBe('cash');
    expect(new Decimal(payload.payments[0]?.amount ?? '0').equals(new Decimal('20'))).toBe(
      true,
    );

    // Success banner + cart cleared.
    await waitFor(() => {
      expect(screen.getByTestId('pos-banner-success')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pos-banner-success-serial')).toHaveTextContent(
      'INV-000042',
    );
    expect(screen.getByTestId('pos-cart-empty')).toBeInTheDocument();
    expect(onFinalized).toHaveBeenCalledTimes(1);
    expect(onFinalized.mock.calls[0]?.[0]).toMatchObject({
      id: 'sale-42',
      serialNo: 'INV-000042',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — server error mapping
// ---------------------------------------------------------------------------

describe('<POSPage /> — server error mapping', () => {
  it('marks the offending line and disables Finalize on OUT_OF_STOCK', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const finalize = vi.fn(() =>
      Promise.resolve(Err('OUT_OF_STOCK', { productId: product.id })),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      finalize,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });
    await user.click(screen.getByTestId('pos-payment-add-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('pos-finalize')).not.toBeDisabled();
    });

    await user.click(screen.getByTestId('pos-finalize'));

    await waitFor(() => {
      expect(finalize).toHaveBeenCalled();
    });

    // Cart preserved.
    expect(screen.getByTestId(`pos-cart-row-${product.id}`)).toBeInTheDocument();
    // Inline OOS marker present.
    expect(
      screen.getByTestId(`pos-cart-row-${product.id}-out-of-stock`),
    ).toBeInTheDocument();
    // Finalize disabled while line is OOS.
    expect(screen.getByTestId('pos-finalize')).toBeDisabled();
    // Banner present too.
    expect(screen.getByTestId('pos-banner-error')).toBeInTheDocument();
    expect(screen.getByTestId('pos-banner-error-code')).toHaveTextContent(
      'OUT_OF_STOCK',
    );
  });

  it('renders the field name on a VALIDATION envelope', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const finalize = vi.fn(() =>
      Promise.resolve(
        Err('VALIDATION', {
          field: 'grandTotal',
          expected: '11.00',
          actual: '10.00',
        }),
      ),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      finalize,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });
    await user.click(screen.getByTestId('pos-payment-add-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('pos-finalize')).not.toBeDisabled();
    });

    await user.click(screen.getByTestId('pos-finalize'));

    await waitFor(() => {
      expect(screen.getByTestId('pos-banner-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pos-banner-error-code')).toHaveTextContent(
      'VALIDATION',
    );
    expect(screen.getByTestId('pos-banner-error-field')).toHaveTextContent(
      'grandTotal',
    );
    expect(screen.getByTestId('pos-banner-error-expected')).toHaveTextContent(
      '11.00',
    );
    expect(screen.getByTestId('pos-banner-error-actual')).toHaveTextContent(
      '10.00',
    );
  });

  it('renders the customer-or-product copy on FK_VIOLATION', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const finalize = vi.fn(() =>
      Promise.resolve(Err('FK_VIOLATION', { reason: 'not_found' })),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      finalize,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });
    await user.click(screen.getByTestId('pos-payment-add-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('pos-finalize')).not.toBeDisabled();
    });

    await user.click(screen.getByTestId('pos-finalize'));

    await waitFor(() => {
      expect(screen.getByTestId('pos-banner-error-message')).toHaveTextContent(
        /customer or product not found/i,
      );
    });
  });
});


// ---------------------------------------------------------------------------
// Tests — customer attach (task 9.3)
// ---------------------------------------------------------------------------

describe('<POSPage /> — customer attach', () => {
  /**
   * Helper: build a cart with one product, one cash payment matching
   * the grand total so the Finalize button is enabled. Used by every
   * customer-attach test as the common baseline.
   */
  async function setupCartReadyToFinalize(opts: {
    user: ReturnType<typeof userEvent.setup>;
    product: ProductDTO;
  }): Promise<void> {
    await scanBarcode({ user: opts.user, barcode: opts.product.barcode ?? '' });
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-cart-row-${opts.product.id}-quantity`),
      ).toHaveValue('1');
    });
    await opts.user.click(screen.getByTestId('pos-payment-add-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('pos-finalize')).not.toBeDisabled();
    });
  }

  it('sends customerId on finalize when a customer is selected from the picker', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const customer = makeCustomer({ id: 'c-7', name: 'Repeat Buyer' });
    const finalize = vi.fn(() =>
      Promise.resolve(
        Ok({
          saleId: 'sale-1',
          serialNo: 'INV-000001',
          sale: makeSaleDTO({
            customerId: customer.id,
            customerName: customer.name,
          }),
        }),
      ),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      customers: [customer],
      finalize,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await setupCartReadyToFinalize({ user, product });

    // Type a search term to trigger customers:list, then pick the
    // returned customer.
    const search = screen.getByTestId('pos-customer-search');
    await user.type(search, 'Repeat');

    // The debounce window is 250 ms; advance by waiting for the
    // result button to render rather than firing real timers (the
    // suite uses real timers per the afterEach).
    await waitFor(() => {
      expect(built.customersList).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-customer-result-${customer.id}`),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(`pos-customer-result-${customer.id}`));

    // The selected-customer summary now reads the picked row's name
    // and phone, and the search/results tree is gone.
    expect(screen.getByTestId('pos-customer-selected-name')).toHaveTextContent(
      'Repeat Buyer',
    );
    expect(screen.queryByTestId('pos-customer-results')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('pos-finalize'));

    await waitFor(() => {
      expect(finalize).toHaveBeenCalledTimes(1);
    });
    const payload = finalize.mock.calls[0]?.[0] as
      | FinalizeSaleInput
      | undefined;
    expect(payload).not.toBeUndefined();
    if (payload === undefined) throw new Error('finalize payload missing');
    expect(payload.customerId).toBe('c-7');
  });

  it('sends customerId: null on finalize when the customer is cleared (walk-in)', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const customer = makeCustomer({ id: 'c-7', name: 'Repeat Buyer' });
    const finalize = vi.fn(() =>
      Promise.resolve(
        Ok({
          saleId: 'sale-1',
          serialNo: 'INV-000001',
          sale: makeSaleDTO(),
        }),
      ),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      customers: [customer],
      finalize,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await setupCartReadyToFinalize({ user, product });

    // Pick the customer first.
    const search = screen.getByTestId('pos-customer-search');
    await user.type(search, 'Repeat');
    await waitFor(() => {
      expect(
        screen.getByTestId(`pos-customer-result-${customer.id}`),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(`pos-customer-result-${customer.id}`));
    expect(screen.getByTestId('pos-customer-selected')).toBeInTheDocument();

    // Then detach (walk-in). The selected-summary disappears and the
    // search input is back.
    await user.click(screen.getByTestId('pos-customer-clear'));
    expect(screen.queryByTestId('pos-customer-selected')).not.toBeInTheDocument();
    expect(screen.getByTestId('pos-customer-search')).toBeInTheDocument();

    await user.click(screen.getByTestId('pos-finalize'));

    await waitFor(() => {
      expect(finalize).toHaveBeenCalledTimes(1);
    });
    const payload = finalize.mock.calls[0]?.[0] as
      | FinalizeSaleInput
      | undefined;
    expect(payload).not.toBeUndefined();
    if (payload === undefined) throw new Error('finalize payload missing');
    expect(payload.customerId).toBeNull();
  });

  it('walk-in default sends customerId: null when no customer is ever picked', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const finalize = vi.fn(() =>
      Promise.resolve(
        Ok({
          saleId: 'sale-1',
          serialNo: 'INV-000001',
          sale: makeSaleDTO(),
        }),
      ),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      finalize,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await setupCartReadyToFinalize({ user, product });
    await user.click(screen.getByTestId('pos-finalize'));

    await waitFor(() => {
      expect(finalize).toHaveBeenCalledTimes(1);
    });
    const payload = finalize.mock.calls[0]?.[0] as
      | FinalizeSaleInput
      | undefined;
    expect(payload).not.toBeUndefined();
    if (payload === undefined) throw new Error('finalize payload missing');
    expect(payload.customerId).toBeNull();
  });

  it('inline + New customer creates and attaches the customer mid-checkout', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const created = makeCustomer({
      id: 'c-new',
      name: 'Fresh Walk-in',
      phone: '555-9999',
    });
    const customersUpsert = vi.fn(() => Promise.resolve(Ok(created)));
    const finalize = vi.fn(() =>
      Promise.resolve(
        Ok({
          saleId: 'sale-1',
          serialNo: 'INV-000001',
          sale: makeSaleDTO({
            customerId: created.id,
            customerName: created.name,
          }),
        }),
      ),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      customersUpsert,
      finalize,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await setupCartReadyToFinalize({ user, product });

    // Open the inline form, fill it, submit.
    await user.click(screen.getByTestId('pos-customer-new'));
    expect(screen.getByTestId('pos-customer-new-form')).toBeInTheDocument();

    await user.type(screen.getByTestId('pos-customer-new-name'), 'Fresh Walk-in');
    await user.type(screen.getByTestId('pos-customer-new-phone'), '555-9999');
    await user.click(screen.getByTestId('pos-customer-new-submit'));

    await waitFor(() => {
      expect(customersUpsert).toHaveBeenCalledTimes(1);
    });
    expect(customersUpsert.mock.calls[0]?.[0]).toEqual({
      name: 'Fresh Walk-in',
      phone: '555-9999',
    });

    // The created customer is now selected.
    await waitFor(() => {
      expect(screen.getByTestId('pos-customer-selected-name')).toHaveTextContent(
        'Fresh Walk-in',
      );
    });

    await user.click(screen.getByTestId('pos-finalize'));

    await waitFor(() => {
      expect(finalize).toHaveBeenCalledTimes(1);
    });
    const payload = finalize.mock.calls[0]?.[0] as
      | FinalizeSaleInput
      | undefined;
    expect(payload).not.toBeUndefined();
    if (payload === undefined) throw new Error('finalize payload missing');
    expect(payload.customerId).toBe('c-new');
  });

  it('surfaces a permission-denied error inline when customers:upsert returns FORBIDDEN', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const customersUpsert = vi.fn(() =>
      Promise.resolve(Err('FORBIDDEN', { reason: 'rbac' })),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      customersUpsert,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });
    await user.click(screen.getByTestId('pos-customer-new'));
    await user.type(screen.getByTestId('pos-customer-new-name'), 'Anyone');
    await user.click(screen.getByTestId('pos-customer-new-submit'));

    await waitFor(() => {
      expect(customersUpsert).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('pos-customer-new-error')).toHaveTextContent(
        /permission/i,
      );
    });
    // Form stays open so the cashier can cancel out without losing the cart.
    expect(screen.getByTestId('pos-customer-new-form')).toBeInTheDocument();
    expect(screen.queryByTestId('pos-customer-selected')).not.toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// Tests — keyboard shortcuts F1–F9 (task 13.5)
// ---------------------------------------------------------------------------

describe('<POSPage /> — keyboard shortcuts', () => {
  /** Fire a fresh `F<n>` keydown on the document. */
  function fireFKey(key: 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F9'): void {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  }

  it('F4 adds a cash payment for the running balance', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '20.00',
      taxRate: '0.00',
    });
    const built = buildStub({ scanByBarcode: { 'BCBC1': product } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);

    await scanBarcode({ user, barcode: 'BCBC1' });
    await waitFor(() => {
      expect(screen.getByTestId('pos-totals-grand')).toHaveTextContent(
        '20.00',
      );
    });

    // Defocus the scanner so F-keys do not race the input.
    (document.activeElement as HTMLElement | null)?.blur();

    fireFKey('F4');

    await waitFor(() => {
      expect(screen.getByTestId('pos-payment-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pos-payment-remaining')).toHaveTextContent(
      '0.00',
    );
    // Finalize is now enabled because the cash payment matches the
    // grand total.
    expect(screen.getByTestId('pos-finalize')).not.toBeDisabled();
  });

  it('F5 adds a card payment and F6 adds a mobile payment', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '15.00',
      taxRate: '0.00',
    });
    const built = buildStub({ scanByBarcode: { 'BCBC1': product } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);
    await scanBarcode({ user, barcode: 'BCBC1' });
    (document.activeElement as HTMLElement | null)?.blur();

    fireFKey('F5');
    await waitFor(() => {
      expect(screen.getByTestId('pos-payment-list')).toBeInTheDocument();
    });
    // First payment is card.
    expect(
      screen.getByTestId('pos-payment-list'),
    ).toHaveTextContent(/card/i);

    // Then drop the card amount to 0 and add a mobile payment for the
    // remaining balance.
    const list = screen.getByTestId('pos-payment-list');
    const amountInput = list.querySelector<HTMLInputElement>(
      'input[data-testid$="-amount"]',
    );
    if (amountInput === null) throw new Error('payment row missing');
    await user.clear(amountInput);
    await user.type(amountInput, '0');
    (document.activeElement as HTMLElement | null)?.blur();

    fireFKey('F6');
    await waitFor(() => {
      expect(
        screen.getByTestId('pos-payment-list'),
      ).toHaveTextContent(/mobile/i);
    });
  });

  it('F9 fires finalize when canFinalize is true', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const finalize = vi.fn(() =>
      Promise.resolve(
        Ok({
          saleId: 'sale-9',
          serialNo: 'INV-000009',
          sale: makeSaleDTO({ id: 'sale-9', serialNo: 'INV-000009' }),
        }),
      ),
    );
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      finalize,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);
    await scanBarcode({ user, barcode: 'BCBC1' });
    await user.click(screen.getByTestId('pos-payment-add-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('pos-finalize')).not.toBeDisabled();
    });
    (document.activeElement as HTMLElement | null)?.blur();

    fireFKey('F9');

    await waitFor(() => {
      expect(finalize).toHaveBeenCalledTimes(1);
    });
  });

  it('F9 does nothing when canFinalize is false (empty cart)', async () => {
    const finalize = vi.fn();
    const built = buildStub({ finalize });
    installApi(built.stub);

    render(<POSPage />);
    (document.activeElement as HTMLElement | null)?.blur();

    fireFKey('F9');

    // Give the handler time to run; finalize should still be untouched.
    await new Promise((r) => setTimeout(r, 10));
    expect(finalize).not.toHaveBeenCalled();
  });

  it('F1 focuses the product search input', async () => {
    const built = buildStub({});
    installApi(built.stub);

    render(<POSPage />);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(
      screen.getByTestId('pos-product-search'),
    );

    fireFKey('F1');

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId('pos-product-search'),
      );
    });
  });

  it('F2 focuses the active discount input', async () => {
    const built = buildStub({});
    installApi(built.stub);

    render(<POSPage />);
    (document.activeElement as HTMLElement | null)?.blur();

    fireFKey('F2');

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId('pos-discount-amount'),
      );
    });
  });

  it('F-keys are ignored while a non-search input is focused', async () => {
    const product = makeProduct(1, {
      barcode: 'BCBC1',
      sellPrice: '10.00',
      taxRate: '0.00',
    });
    const finalize = vi.fn();
    const built = buildStub({
      scanByBarcode: { 'BCBC1': product },
      finalize,
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(<POSPage />);
    await scanBarcode({ user, barcode: 'BCBC1' });
    await user.click(screen.getByTestId('pos-payment-add-cash'));
    await waitFor(() => {
      expect(screen.getByTestId('pos-finalize')).not.toBeDisabled();
    });

    // Focus the discount input — a real <input> element. F9 should NOT
    // fire while it's focused so the cashier can edit numbers without
    // submitting.
    screen.getByTestId('pos-discount-amount').focus();
    fireFKey('F9');

    await new Promise((r) => setTimeout(r, 10));
    expect(finalize).not.toHaveBeenCalled();
  });
});
