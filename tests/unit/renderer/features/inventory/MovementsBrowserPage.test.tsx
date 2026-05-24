/**
 * Unit tests for the inventory movements browser page (task 5.5.2).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by `ProductsListPage.test.tsx`,
 * `AdjustPage.test.tsx`, and `VirtualizedTable.test.tsx`. The shared
 * `<VirtualizedTable>` is exercised end-to-end — these tests verify
 * the integration, not the table's internal page-accumulation logic
 * (already covered by its own suite).
 *
 * Coverage:
 *   - Renders ledger rows for Admin and surfaces the permission-denied
 *     fallback for Cashiers (Req 8.2).
 *   - Filter changes (movement type, date range) reset the cursor and
 *     refetch — the latest IPC call carries the new filter and no
 *     `cursor` (Req 16.1, 16.5).
 *   - Row click invokes the navigation callback with the originating
 *     reference's `referenceType` + `referenceId` (Req 3.1).
 *
 * Validates: Requirements 3.1, 8.2, 16.1, 16.5.
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

import { MovementsBrowserPage } from '@renderer/features/inventory/MovementsBrowserPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { InventoryMovementDTO } from '@shared/dto/index';
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

function makeMovement(
  i: number,
  overrides: Partial<InventoryMovementDTO> = {},
): InventoryMovementDTO {
  return {
    id: `m-${i}`,
    productId: `p-${i}`,
    productName: `Product ${i}`,
    quantityDelta: i % 2 === 0 ? -1 : 2,
    movementType: 'sale',
    referenceType: 'sale',
    referenceId: `s-${i}`,
    userId: 'u-admin',
    userName: 'admin',
    timestamp: `2026-05-24T10:0${i % 10}:00.000Z`,
    ...overrides,
  };
}

function pageOf(
  rows: readonly InventoryMovementDTO[],
): ListResponse<InventoryMovementDTO> {
  return { rows, nextCursor: null };
}

// ---------------------------------------------------------------------------
// API stub builder
// ---------------------------------------------------------------------------

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly movementsList: MockInstance;
  readonly movementsCount: MockInstance;
  readonly productsList: MockInstance;
}

function buildStub(rows: readonly InventoryMovementDTO[]): BuiltStub {
  const movementsList = vi.fn(() => Promise.resolve(Ok(pageOf(rows))));
  const movementsCount = vi.fn(() =>
    Promise.resolve(Ok({ totalCount: rows.length })),
  );
  const productsList = vi.fn(() => Promise.resolve(Ok({ rows: [], nextCursor: null })));

  const stub: Partial<Api> = {
    'inventory_movements:list': movementsList,
    'inventory_movements:count': movementsCount,
    'products:list': productsList,
  };
  return { stub, movementsList, movementsCount, productsList };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<MovementsBrowserPage /> — role gating', () => {
  it('renders the table for Admins', async () => {
    const rows = [makeMovement(1), makeMovement(2)];
    const built = buildStub(rows);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <MovementsBrowserPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('movement-row-m-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('movement-row-m-2')).toBeInTheDocument();
    expect(screen.getByTestId('movements-table-header')).toBeInTheDocument();
    expect(
      screen.queryByTestId('movements-permission-denied'),
    ).not.toBeInTheDocument();
  });

  it('shows the permission-denied surface for Cashiers', () => {
    const built = buildStub([makeMovement(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={cashierSession}>
        <MovementsBrowserPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('movements-permission-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('movements-table-header')).not.toBeInTheDocument();
    // The list IPC must not be reached at all when the gate denies the role.
    expect(built.movementsList).not.toHaveBeenCalled();
  });

  it('shows the permission-denied surface for unauthenticated users', () => {
    const built = buildStub([]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={null}>
        <MovementsBrowserPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('movements-permission-denied')).toBeInTheDocument();
    expect(built.movementsList).not.toHaveBeenCalled();
  });
});

describe('<MovementsBrowserPage /> — filter changes reset the cursor', () => {
  it('issues a fresh first-page request when the movement type changes', async () => {
    const built = buildStub([makeMovement(1)]);
    installApi(built.stub);

    const user = userEvent.setup();

    render(
      <AuthProvider initialSession={adminSession}>
        <MovementsBrowserPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.movementsList).toHaveBeenCalled();
    });

    const callsBefore = built.movementsList.mock.calls.length;
    await user.selectOptions(
      screen.getByTestId('movements-type-filter'),
      'adjustment',
    );

    await waitFor(() => {
      expect(built.movementsList.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    const lastReq = built.movementsList.mock.calls.at(-1)?.[0] as
      | {
          filter?: { movementType?: string };
          cursor?: string;
        }
      | undefined;
    expect(lastReq?.filter?.movementType).toBe('adjustment');
    expect(lastReq?.cursor).toBeUndefined();
  });

  it('forwards a date range as inclusive ISO timestamps and resets the cursor', async () => {
    const built = buildStub([makeMovement(1)]);
    installApi(built.stub);

    const user = userEvent.setup();

    render(
      <AuthProvider initialSession={adminSession}>
        <MovementsBrowserPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.movementsList).toHaveBeenCalled();
    });

    const callsBefore = built.movementsList.mock.calls.length;
    // `userEvent.type` would dispatch one keystroke per character on a
    // date input, none of which produce a valid intermediate value;
    // `fireEvent`-style assignment via `clear` + `type` of the full
    // ISO date works for the `<input type="date">` form control.
    await user.type(screen.getByTestId('movements-date-from'), '2026-05-01');
    await user.type(screen.getByTestId('movements-date-to'), '2026-05-31');

    await waitFor(() => {
      expect(built.movementsList.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    const lastReq = built.movementsList.mock.calls.at(-1)?.[0] as
      | {
          filter?: { dateFrom?: string; dateTo?: string };
          cursor?: string;
        }
      | undefined;
    expect(lastReq?.filter?.dateFrom).toBe('2026-05-01T00:00:00.000Z');
    expect(lastReq?.filter?.dateTo).toBe('2026-05-31T23:59:59.999Z');
    expect(lastReq?.cursor).toBeUndefined();
  });
});

describe('<MovementsBrowserPage /> — row navigation', () => {
  it('invokes the navigate callback with the originating reference', async () => {
    const rows = [
      makeMovement(1, {
        movementType: 'purchase',
        referenceType: 'purchase',
        referenceId: 'pu-42',
      }),
    ];
    const built = buildStub(rows);
    installApi(built.stub);

    const onNavigate = vi.fn();
    const user = userEvent.setup();

    render(
      <AuthProvider initialSession={adminSession}>
        <MovementsBrowserPage onNavigate={onNavigate} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('movement-row-m-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('movement-row-m-1'));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      referenceType: 'purchase',
      referenceId: 'pu-42',
    });
  });
});
