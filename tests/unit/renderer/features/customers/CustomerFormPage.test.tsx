/**
 * Unit tests for the customer form (task 9.2, Phase 9).
 *
 * Coverage:
 *   - Cashier sees the permission-denied surface (write-gate).
 *   - Form renders all required fields for Admin.
 *   - Empty name keeps the submit button disabled.
 *   - Successful submit calls `customers:upsert` with the expected
 *     payload and invokes `onClose` with the returned DTO.
 *   - Edit mode passes the existing id.
 *   - Empty optional phone is coerced to null on the wire.
 *   - `VALIDATION { field: 'name' }` from the server surfaces inline.
 *   - `INTERNAL` from the server surfaces in a banner.
 *   - Cancel calls `onClose` with no DTO.
 *
 * Validates: Requirements 7.1, 7.2, 8.3.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomerFormPage } from '@renderer/features/customers/CustomerFormPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { CustomerDTO, CustomerInput } from '@shared/dto/index';
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

const cashierSession: SessionDTO = {
  sessionId: 's-cashier',
  userId: 'u-cashier',
  username: 'cashier',
  role: 'Cashier',
};

function makeStub(opts: { upsert: ReturnType<typeof vi.fn> }): Partial<Api> {
  return {
    'customers:upsert': opts.upsert as unknown as Api['customers:upsert'],
  };
}

const noop = (): void => {
  // no-op
};

const savedDTO: CustomerDTO = {
  id: 'cust-1',
  name: 'Alice Walker',
  phone: '555-9999',
  createdAt: '2024-01-01T10:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Tests — role gating
// ---------------------------------------------------------------------------

describe('<CustomerFormPage /> — role gating', () => {
  it('shows the permission-denied surface to Cashiers', () => {
    installApi(makeStub({ upsert: vi.fn() }));

    render(
      <AuthProvider initialSession={cashierSession}>
        <CustomerFormPage onClose={noop} />
      </AuthProvider>,
    );

    expect(
      screen.getByTestId('customer-form-permission-denied'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('customer-form-submit')).not.toBeInTheDocument();
  });

  it('shows the permission-denied surface to unauthenticated users', () => {
    installApi(makeStub({ upsert: vi.fn() }));

    render(
      <AuthProvider initialSession={null}>
        <CustomerFormPage onClose={noop} />
      </AuthProvider>,
    );

    expect(
      screen.getByTestId('customer-form-permission-denied'),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — rendering
// ---------------------------------------------------------------------------

describe('<CustomerFormPage /> — rendering', () => {
  it('renders the required fields in create mode for Admin', () => {
    installApi(makeStub({ upsert: vi.fn() }));

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerFormPage onClose={noop} />
      </AuthProvider>,
    );

    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/phone/i)).toBeInTheDocument();
    expect(screen.getByTestId('customer-form-submit')).toBeInTheDocument();
    expect(screen.getByTestId('customer-form-cancel')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — client-side validation
// ---------------------------------------------------------------------------

describe('<CustomerFormPage /> — client-side validation', () => {
  it('keeps submit disabled while name is empty', () => {
    installApi(makeStub({ upsert: vi.fn() }));

    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerFormPage onClose={noop} />
      </AuthProvider>,
    );

    expect(screen.getByTestId('customer-form-submit')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Tests — successful submit
// ---------------------------------------------------------------------------

describe('<CustomerFormPage /> — successful submit', () => {
  it('calls customers:upsert and onClose with the saved DTO (create)', async () => {
    const upsert = vi.fn().mockResolvedValue(Ok(savedDTO));
    installApi(makeStub({ upsert }));
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerFormPage onClose={onClose} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^name/i), 'Alice Walker');
    await user.type(screen.getByLabelText(/phone/i), '555-9999');

    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    const payload = upsert.mock.calls[0]?.[0] as CustomerInput | undefined;
    expect(payload).toMatchObject({
      name: 'Alice Walker',
      phone: '555-9999',
    });
    expect(payload?.id).toBeUndefined();

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
        <CustomerFormPage customer={savedDTO} onClose={onClose} />
      </AuthProvider>,
    );

    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledTimes(1);
    });
    const payload = upsert.mock.calls[0]?.[0] as CustomerInput | undefined;
    expect(payload?.id).toBe('cust-1');
  });

  it('coerces empty optional phone to null on the wire', async () => {
    const upsert = vi.fn().mockResolvedValue(Ok(savedDTO));
    installApi(makeStub({ upsert }));

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerFormPage onClose={noop} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^name/i), 'Bare');

    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalled();
    });
    const payload = upsert.mock.calls[0]?.[0] as CustomerInput | undefined;
    expect(payload?.phone).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — server error mapping
// ---------------------------------------------------------------------------

describe('<CustomerFormPage /> — server error mapping', () => {
  it('surfaces VALIDATION on a field inline next to that input', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValue(Err('VALIDATION', { field: 'name' }));
    installApi(makeStub({ upsert }));

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerFormPage onClose={noop} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^name/i), 'Some name');
    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalled();
    });

    const nameInput = screen.getByLabelText(/^name/i);
    const describedBy = nameInput.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const errorEl = document.getElementById(describedBy ?? '');
    expect(errorEl).not.toBeNull();
  });

  it('surfaces a generic banner for non-field error envelopes', async () => {
    const upsert = vi.fn().mockResolvedValue(Err('INTERNAL'));
    installApi(makeStub({ upsert }));

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerFormPage onClose={noop} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^name/i), 'Whatever');
    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('customer-form-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('customer-form-banner')).toHaveTextContent('INTERNAL');
  });
});

// ---------------------------------------------------------------------------
// Tests — cancel
// ---------------------------------------------------------------------------

describe('<CustomerFormPage /> — cancel', () => {
  it('invokes onClose with no DTO when Cancel is clicked', async () => {
    installApi(makeStub({ upsert: vi.fn() }));
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <CustomerFormPage onClose={onClose} />
      </AuthProvider>,
    );

    await user.click(screen.getByTestId('customer-form-cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith();
  });
});
