/**
 * Unit tests for the printer settings page (Phase 8, task 8.6).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by other feature page tests
 * (`AdjustPage.test.tsx`, `SupplierFormPage.test.tsx`).
 *
 * Coverage:
 *   - Loading state renders before `settings:get` resolves.
 *   - Form renders the kind select, target input, save + test buttons
 *     for the Admin role.
 *   - Cashier sees the permission-denied surface instead of the form.
 *   - Existing config is seeded into the form on load.
 *   - Save calls `settings:set` with the JSON-encoded value.
 *   - Save error envelope renders inline.
 *   - Test print calls `printer:test` and renders the success/error
 *     indicator inline.
 *
 * Validates: Requirements 4.7, 8.2.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrinterSettingsPage } from '@renderer/features/settings/PrinterSettingsPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Err, Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { SessionDTO } from '@shared/ipc-contract';

// ---------------------------------------------------------------------------
// Globals
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

// ---------------------------------------------------------------------------
// Stub builder
// ---------------------------------------------------------------------------

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly settingsGet: ReturnType<typeof vi.fn>;
  readonly settingsSet: ReturnType<typeof vi.fn>;
  readonly printerTest: ReturnType<typeof vi.fn>;
}

function buildStub(opts?: {
  readonly currentValue?: unknown;
  readonly settingsSet?: ReturnType<typeof vi.fn>;
  readonly printerTest?: ReturnType<typeof vi.fn>;
}): BuiltStub {
  const currentValue = opts?.currentValue ?? null;
  const settingsGet = vi.fn(() => Promise.resolve(Ok({ value: currentValue })));
  const settingsSet =
    opts?.settingsSet ?? vi.fn(() => Promise.resolve(Ok(undefined)));
  const printerTest =
    opts?.printerTest ?? vi.fn(() => Promise.resolve(Ok({ adapter: 'escpos' as const })));

  const stub: Partial<Api> = {
    'settings:get': settingsGet,
    'settings:set': settingsSet,
    'printer:test': printerTest,
  };

  return { stub, settingsGet, settingsSet, printerTest };
}

// ---------------------------------------------------------------------------
// Tests — role gating
// ---------------------------------------------------------------------------

describe('<PrinterSettingsPage /> — role gating', () => {
  it('shows the permission-denied surface for Cashiers', () => {
    installApi(buildStub().stub);

    render(
      <AuthProvider initialSession={cashierSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('printer-settings-permission-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('printer-settings-kind')).not.toBeInTheDocument();
  });

  it('shows the permission-denied surface for unauthenticated users', () => {
    installApi(buildStub().stub);

    render(
      <AuthProvider initialSession={null}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('printer-settings-permission-denied')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — initial load
// ---------------------------------------------------------------------------

describe('<PrinterSettingsPage /> — initial load', () => {
  it('renders the loading state before settings:get resolves', () => {
    // Build a stub whose settings:get never resolves to capture the loading state.
    const settingsGet = vi.fn(() => new Promise(() => undefined));
    installApi({ 'settings:get': settingsGet as unknown as Api['settings:get'] });

    render(
      <AuthProvider initialSession={adminSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('printer-settings-loading')).toBeInTheDocument();
  });

  it('seeds the form from the stored value', async () => {
    const built = buildStub({
      currentValue: { kind: 'network', target: '10.0.0.5:9100' },
    });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-kind')).toBeInTheDocument();
    });

    expect(screen.getByTestId('printer-settings-kind')).toHaveValue('network');
    expect(screen.getByTestId('printer-settings-target')).toHaveValue('10.0.0.5:9100');
    expect(built.settingsGet).toHaveBeenCalledWith({ key: 'printer.escpos' });
  });

  it('falls back to defaults when the stored row is missing', async () => {
    const built = buildStub({ currentValue: null });
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-kind')).toBeInTheDocument();
    });

    expect(screen.getByTestId('printer-settings-kind')).toHaveValue('usb');
    expect(screen.getByTestId('printer-settings-target')).toHaveValue('');
  });

  it('renders the load error inline when settings:get returns Err', async () => {
    const settingsGet = vi.fn(() => Promise.resolve(Err('INTERNAL')));
    installApi({ 'settings:get': settingsGet });

    render(
      <AuthProvider initialSession={adminSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-load-error')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Save
// ---------------------------------------------------------------------------

describe('<PrinterSettingsPage /> — Save', () => {
  it('persists via settings:set with the JSON-encoded value', async () => {
    const built = buildStub({
      currentValue: { kind: 'usb', target: '' },
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-kind')).toBeInTheDocument();
    });

    await user.selectOptions(screen.getByTestId('printer-settings-kind'), 'network');
    await user.type(screen.getByTestId('printer-settings-target'), '192.168.1.50:9100');

    await user.click(screen.getByTestId('printer-settings-save'));

    await waitFor(() => {
      expect(built.settingsSet).toHaveBeenCalledTimes(1);
    });
    const payload = built.settingsSet.mock.calls[0]?.[0] as
      | { key: string; value: unknown }
      | undefined;
    expect(payload?.key).toBe('printer.escpos');
    expect(payload?.value).toEqual({
      kind: 'network',
      target: '192.168.1.50:9100',
    });

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-save-success')).toBeInTheDocument();
    });
  });

  it('renders the save error envelope inline on Err', async () => {
    const built = buildStub({
      currentValue: { kind: 'usb', target: '' },
      settingsSet: vi.fn(() => Promise.resolve(Err('FORBIDDEN'))),
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-kind')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('printer-settings-save'));

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-save-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('printer-settings-save-error')).toHaveTextContent('FORBIDDEN');
    expect(screen.queryByTestId('printer-settings-save-success')).not.toBeInTheDocument();
  });

  it('updates the helper text when kind changes', async () => {
    const built = buildStub({ currentValue: { kind: 'usb', target: '' } });
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-target-help')).toBeInTheDocument();
    });

    expect(screen.getByTestId('printer-settings-target-help')).toHaveTextContent(/04b8:0202/i);

    await user.selectOptions(screen.getByTestId('printer-settings-kind'), 'serial');
    expect(screen.getByTestId('printer-settings-target-help')).toHaveTextContent(/COM3/i);

    await user.selectOptions(screen.getByTestId('printer-settings-kind'), 'network');
    expect(screen.getByTestId('printer-settings-target-help')).toHaveTextContent(/9100/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — Test print
// ---------------------------------------------------------------------------

describe('<PrinterSettingsPage /> — Test print', () => {
  it('calls printer:test and renders the success indicator with the adapter name', async () => {
    const built = buildStub({
      currentValue: { kind: 'usb', target: 'COM3' },
      printerTest: vi.fn(() => Promise.resolve(Ok({ adapter: 'pdf', output: '/tmp/r.pdf' }))),
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-test')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('printer-settings-test'));

    await waitFor(() => {
      expect(built.printerTest).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-test-success')).toBeInTheDocument();
    });
    expect(screen.getByTestId('printer-settings-test-success')).toHaveTextContent('pdf');
    expect(screen.getByTestId('printer-settings-test-success')).toHaveTextContent('/tmp/r.pdf');
  });

  it('renders the test-print error inline on Err', async () => {
    const built = buildStub({
      currentValue: { kind: 'usb', target: 'COM3' },
      printerTest: vi.fn(() =>
        Promise.resolve(Err('PRINTER_FAILURE', { reason: 'io', cause: 'no printer' })),
      ),
    });
    installApi(built.stub);

    const user = userEvent.setup();
    render(
      <AuthProvider initialSession={adminSession}>
        <PrinterSettingsPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-test')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('printer-settings-test'));

    await waitFor(() => {
      expect(screen.getByTestId('printer-settings-test-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('printer-settings-test-error')).toHaveTextContent(
      'PRINTER_FAILURE',
    );
    expect(screen.queryByTestId('printer-settings-test-success')).not.toBeInTheDocument();
  });
});
