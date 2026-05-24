/**
 * Unit tests for the products form (task 4.4).
 *
 * Coverage:
 *   - Form renders all required fields.
 *   - Empty SKU keeps the submit button disabled (or surfaces the
 *     client-side validation message via `validate()`).
 *   - Successful submit calls `products:upsert` with the expected
 *     payload and invokes `onClose` with the returned DTO.
 *   - `UNIQUE_VIOLATION { field: 'sku' }` from the server surfaces
 *     inline next to the SKU input.
 *   - `VALIDATION { field: 'sellPrice' }` from the server surfaces
 *     inline next to the sell-price input.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 8.3.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFormPage } from '@renderer/features/products/ProductFormPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { CategoryDTO, ProductDTO, ProductInput } from '@shared/dto/index';
import type { SessionDTO } from '@shared/ipc-contract';

// ---------------------------------------------------------------------------
// Test helpers
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
});

const adminSession: SessionDTO = {
  sessionId: 's-admin',
  userId: 'u-admin',
  username: 'admin',
  role: 'Admin',
};

const categories: readonly CategoryDTO[] = [
  { id: 'c-fruit', name: 'Fruit' },
  { id: 'c-veg', name: 'Vegetable' },
];

function makeStub(opts: {
  upsert: ReturnType<typeof vi.fn>;
}): Partial<Api> {
  const stub = {
    'products:upsert': opts.upsert,
    'categories:list': vi.fn().mockResolvedValue(Ok({ rows: categories })),
  };
  return stub as Partial<Api>;
}

const noop = (): void => {
  // no-op onClose handler used by tests that don't care about close.
};

const savedDTO: ProductDTO = {
  id: 'p-1',
  sku: 'NEW-1',
  name: 'New Apple',
  categoryId: 'c-fruit',
  categoryName: 'Fruit',
  barcode: null,
  buyPrice: '1.00',
  sellPrice: '2.00',
  taxRate: '0.00',
  warrantyMonths: 0,
  reorderLevel: 0,
  onHand: 0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<ProductFormPage /> — rendering', () => {
  it('renders every required field in create mode', () => {
    installApi(makeStub({ upsert: vi.fn() }));

    render(
      <AuthProvider initialSession={adminSession}>
        <ProductFormPage onClose={noop} categories={categories} />
      </AuthProvider>,
    );

    expect(screen.getByLabelText(/^sku/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^category/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/barcode/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/buy price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sell price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tax rate/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/warranty/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/reorder level/i)).toBeInTheDocument();
    expect(screen.getByTestId('product-form-submit')).toBeInTheDocument();
    expect(screen.getByTestId('product-form-cancel')).toBeInTheDocument();
  });
});

describe('<ProductFormPage /> — client-side validation', () => {
  it('keeps submit disabled while required fields are empty', () => {
    installApi(makeStub({ upsert: vi.fn() }));

    render(
      <AuthProvider initialSession={adminSession}>
        <ProductFormPage onClose={noop} categories={categories} />
      </AuthProvider>,
    );

    expect(screen.getByTestId('product-form-submit')).toBeDisabled();
  });
});

describe('<ProductFormPage /> — successful submit', () => {
  it('calls products:upsert and onClose with the saved DTO', async () => {
    const upsert = vi.fn().mockResolvedValue(Ok(savedDTO));
    installApi(makeStub({ upsert }));
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <ProductFormPage onClose={onClose} categories={categories} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^sku/i), 'NEW-1');
    await user.type(screen.getByLabelText(/^name/i), 'New Apple');
    await user.selectOptions(screen.getByLabelText(/^category/i), 'c-fruit');
    // Buy / sell / tax / warranty / reorder default to '0' which passes
    // the regex; bump sell price so the test exercises a real value.
    const sellInput = screen.getByLabelText(/sell price/i);
    await user.clear(sellInput);
    await user.type(sellInput, '2.00');

    await user.click(screen.getByTestId('product-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    const payload = upsert.mock.calls[0]?.[0] as ProductInput | undefined;
    expect(payload).toMatchObject({
      sku: 'NEW-1',
      name: 'New Apple',
      categoryId: 'c-fruit',
      sellPrice: '2.00',
    });
    expect(payload?.id).toBeUndefined();
    expect(payload?.barcode).toBeNull();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith(savedDTO);
    });
  });

  it('passes the existing id in edit mode', async () => {
    const upsert = vi.fn().mockResolvedValue(Ok(savedDTO));
    installApi(makeStub({ upsert }));
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <ProductFormPage
          onClose={onClose}
          categories={categories}
          product={savedDTO}
        />
      </AuthProvider>,
    );

    await user.click(screen.getByTestId('product-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    const payload = upsert.mock.calls[0]?.[0] as ProductInput | undefined;
    expect(payload?.id).toBe('p-1');
  });
});

describe('<ProductFormPage /> — server error mapping', () => {
  it('surfaces UNIQUE_VIOLATION on sku inline next to the SKU input', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValue(Err('UNIQUE_VIOLATION', { field: 'sku' }));
    installApi(makeStub({ upsert }));

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <ProductFormPage onClose={noop} categories={categories} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^sku/i), 'EXISTING');
    await user.type(screen.getByLabelText(/^name/i), 'Whatever');
    await user.selectOptions(screen.getByLabelText(/^category/i), 'c-fruit');

    await user.click(screen.getByTestId('product-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalled();
    });

    const skuInput = screen.getByLabelText(/^sku/i);
    const describedBy = skuInput.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    const errorEl = document.getElementById(describedBy ?? '');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toMatch(/already in use/i);

    // Generic banner should NOT appear for field-targeted errors.
    expect(screen.queryByTestId('product-form-banner')).not.toBeInTheDocument();
  });

  it('surfaces VALIDATION on a field inline next to that input', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValue(Err('VALIDATION', { field: 'sellPrice' }));
    installApi(makeStub({ upsert }));

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <ProductFormPage onClose={noop} categories={categories} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^sku/i), 'OK-1');
    await user.type(screen.getByLabelText(/^name/i), 'Whatever');
    await user.selectOptions(screen.getByLabelText(/^category/i), 'c-fruit');

    await user.click(screen.getByTestId('product-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalled();
    });

    const sellInput = screen.getByLabelText(/sell price/i);
    const describedBy = sellInput.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    const errorEl = document.getElementById(describedBy ?? '');
    expect(errorEl).not.toBeNull();
    // Default VALIDATION message text from the result envelope.
    expect(errorEl?.textContent).toMatch(/validation/i);
  });

  it('surfaces a generic banner for non-field error envelopes', async () => {
    const upsert = vi.fn().mockResolvedValue(Err('INTERNAL'));
    installApi(makeStub({ upsert }));

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <ProductFormPage onClose={noop} categories={categories} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^sku/i), 'OK-1');
    await user.type(screen.getByLabelText(/^name/i), 'Whatever');
    await user.selectOptions(screen.getByLabelText(/^category/i), 'c-fruit');

    await user.click(screen.getByTestId('product-form-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('product-form-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('product-form-banner')).toHaveTextContent('INTERNAL');
  });
});

describe('<ProductFormPage /> — cancel', () => {
  it('invokes onClose with no DTO when Cancel is clicked', async () => {
    installApi(makeStub({ upsert: vi.fn() }));
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <ProductFormPage onClose={onClose} categories={categories} />
      </AuthProvider>,
    );

    await user.click(screen.getByTestId('product-form-cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith();
  });
});
