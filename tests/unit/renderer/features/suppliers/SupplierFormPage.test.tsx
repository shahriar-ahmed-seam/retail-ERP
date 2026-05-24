/**
 * Unit tests for the suppliers form (task 6.1, Phase 6).
 *
 * Coverage:
 *   - Form renders all required fields.
 *   - Empty name keeps the submit button disabled.
 *   - Successful submit calls `suppliers:upsert` with the expected
 *     payload and invokes `onClose` with the returned DTO.
 *   - `VALIDATION { field: 'name' }` from the server surfaces inline.
 *   - Cancel calls `onClose` with no DTO.
 *
 * Validates: Requirements 6.1, 6.2.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SupplierFormPage } from '@renderer/features/suppliers/SupplierFormPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { SupplierDTO, SupplierInput } from '@shared/dto/index';
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

function makeStub(opts: { upsert: ReturnType<typeof vi.fn> }): Partial<Api> {
  return {
    'suppliers:upsert': opts.upsert,
  };
}

const noop = (): void => {
  // no-op
};

const savedDTO: SupplierDTO = {
  id: 'sup-1',
  name: 'Acme Tools',
  phone: '555-9',
  address: 'Lane',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<SupplierFormPage /> — rendering', () => {
  it('renders the required fields in create mode', () => {
    installApi(makeStub({ upsert: vi.fn() }));

    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierFormPage onClose={noop} />
      </AuthProvider>,
    );

    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/phone/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/address/i)).toBeInTheDocument();
    expect(screen.getByTestId('supplier-form-submit')).toBeInTheDocument();
    expect(screen.getByTestId('supplier-form-cancel')).toBeInTheDocument();
  });
});

describe('<SupplierFormPage /> — client-side validation', () => {
  it('keeps submit disabled while name is empty', () => {
    installApi(makeStub({ upsert: vi.fn() }));

    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierFormPage onClose={noop} />
      </AuthProvider>,
    );

    expect(screen.getByTestId('supplier-form-submit')).toBeDisabled();
  });
});

describe('<SupplierFormPage /> — successful submit', () => {
  it('calls suppliers:upsert and onClose with the saved DTO (create)', async () => {
    const upsert = vi.fn().mockResolvedValue(Ok(savedDTO));
    installApi(makeStub({ upsert }));
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierFormPage onClose={onClose} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^name/i), 'Acme Tools');
    await user.type(screen.getByLabelText(/phone/i), '555-9');
    await user.type(screen.getByLabelText(/address/i), 'Lane');

    await user.click(screen.getByTestId('supplier-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    const payload = upsert.mock.calls[0]?.[0] as SupplierInput | undefined;
    expect(payload).toMatchObject({
      name: 'Acme Tools',
      phone: '555-9',
      address: 'Lane',
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
        <SupplierFormPage supplier={savedDTO} onClose={onClose} />
      </AuthProvider>,
    );

    await user.click(screen.getByTestId('supplier-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledTimes(1);
    });
    const payload = upsert.mock.calls[0]?.[0] as SupplierInput | undefined;
    expect(payload?.id).toBe('sup-1');
  });

  it('coerces empty optional fields to null on the wire', async () => {
    const upsert = vi.fn().mockResolvedValue(Ok(savedDTO));
    installApi(makeStub({ upsert }));

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierFormPage onClose={noop} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^name/i), 'Bare');

    await user.click(screen.getByTestId('supplier-form-submit'));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalled();
    });
    const payload = upsert.mock.calls[0]?.[0] as SupplierInput | undefined;
    expect(payload?.phone).toBeNull();
    expect(payload?.address).toBeNull();
  });
});

describe('<SupplierFormPage /> — server error mapping', () => {
  it('surfaces VALIDATION on a field inline next to that input', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValue(Err('VALIDATION', { field: 'name' }));
    installApi(makeStub({ upsert }));

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierFormPage onClose={noop} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^name/i), 'Some name');
    await user.click(screen.getByTestId('supplier-form-submit'));

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
        <SupplierFormPage onClose={noop} />
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/^name/i), 'Whatever');
    await user.click(screen.getByTestId('supplier-form-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('supplier-form-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('supplier-form-banner')).toHaveTextContent('INTERNAL');
  });
});

describe('<SupplierFormPage /> — cancel', () => {
  it('invokes onClose with no DTO when Cancel is clicked', async () => {
    installApi(makeStub({ upsert: vi.fn() }));
    const onClose = vi.fn();

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <SupplierFormPage onClose={onClose} />
      </AuthProvider>,
    );

    await user.click(screen.getByTestId('supplier-form-cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith();
  });
});
