/**
 * Unit tests for the audit log viewer page (Phase 12, task 12.1).
 *
 * Mounts the real component against a stubbed `window.api`, mirroring
 * the conventions established by the other list-page suites
 * (CustomersListPage, MovementsBrowserPage). The shared
 * `<VirtualizedTable>` is exercised end-to-end.
 *
 * Coverage:
 *   - Permission gate: unauthenticated and Cashier sessions are denied.
 *   - Renders rows from `audit:list`.
 *   - Action-type filter is forwarded into `filter.actionType`.
 *   - User-id filter is debounced and forwarded.
 *   - Date-range filter is widened to start/end-of-day ISO strings.
 *
 * Validates: Requirements 13.1, 13.2, 13.3, 13.4, 16.1, 16.5, 8.2.
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

import { AuditLogPage } from '@renderer/features/users/AuditLogPage';
import { AuthProvider } from '@renderer/lib/auth-context';
import { Ok } from '@shared/result';

import type { Api } from '@renderer/lib/api';
import type { AuditLogDTO } from '@shared/dto/index';
import type { ListResponse, SessionDTO } from '@shared/ipc-contract';
import type { Result } from '@shared/result';

// ---------------------------------------------------------------------------
// jsdom shims
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

class NoopResizeObserver {
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: NoopResizeObserver,
  });
});

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

function makeAudit(i: number, overrides: Partial<AuditLogDTO> = {}): AuditLogDTO {
  return {
    id: `a-${i}`,
    actionType: 'price.change',
    entityType: 'product',
    entityId: `p-${i}`,
    previous: { sellPrice: '5.00' },
    next: { sellPrice: '6.00' },
    userId: 'u-admin',
    userName: 'owner',
    timestamp: '2026-05-24T12:00:00.000Z',
    ...overrides,
  };
}

function pageOf(rows: readonly AuditLogDTO[]): ListResponse<AuditLogDTO> {
  return { rows, nextCursor: null };
}

interface BuiltStub {
  readonly stub: Partial<Api>;
  readonly auditList: MockInstance;
  readonly auditCount: MockInstance;
}

function buildStub(rows: readonly AuditLogDTO[]): BuiltStub {
  const auditList = vi.fn(
    (): Promise<Result<ListResponse<AuditLogDTO>>> =>
      Promise.resolve(Ok(pageOf(rows))),
  );
  const auditCount = vi.fn(() => Promise.resolve(Ok({ totalCount: rows.length })));
  const stub: Partial<Api> = {
    'audit:list': auditList,
    'audit:count': auditCount,
  };
  return { stub, auditList, auditCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('<AuditLogPage /> — role gating', () => {
  it('shows the permission-denied screen to unauthenticated users', () => {
    const built = buildStub([makeAudit(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={null}>
        <AuditLogPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('audit-permission-denied')).toBeInTheDocument();
    expect(built.auditList).not.toHaveBeenCalled();
  });

  it('shows the permission-denied screen to Cashier sessions', () => {
    const built = buildStub([makeAudit(1)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={cashierSession}>
        <AuditLogPage />
      </AuthProvider>,
    );

    expect(screen.getByTestId('audit-permission-denied')).toBeInTheDocument();
    expect(built.auditList).not.toHaveBeenCalled();
  });

  it('renders the audit log to Admin sessions', async () => {
    const built = buildStub([makeAudit(1), makeAudit(2)]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <AuditLogPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('audit-row-a-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('audit-row-a-2')).toBeInTheDocument();
  });
});

describe('<AuditLogPage /> — rendering', () => {
  it('renders the empty state when no rows match', async () => {
    const built = buildStub([]);
    installApi(built.stub);

    render(
      <AuthProvider initialSession={adminSession}>
        <AuditLogPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('audit-empty')).toBeInTheDocument();
    });
  });
});

describe('<AuditLogPage /> — filtering', () => {
  it('forwards the actionType filter to audit:list', async () => {
    const built = buildStub([makeAudit(1)]);
    installApi(built.stub);

    const user = userEvent.setup();

    render(
      <AuthProvider initialSession={adminSession}>
        <AuditLogPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.auditList).toHaveBeenCalled();
    });

    await user.selectOptions(
      screen.getByTestId('audit-action-type'),
      'role.change',
    );

    await waitFor(() => {
      const lastCall =
        built.auditList.mock.calls[built.auditList.mock.calls.length - 1];
      const req = lastCall?.[0] as { filter?: { actionType?: string } } | undefined;
      expect(req?.filter).toEqual({ actionType: 'role.change' });
    });
  });

  it('widens dateFrom/dateTo to start/end-of-day ISO strings', async () => {
    const built = buildStub([makeAudit(1)]);
    installApi(built.stub);

    const user = userEvent.setup();

    render(
      <AuthProvider initialSession={adminSession}>
        <AuditLogPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(built.auditList).toHaveBeenCalled();
    });

    // jsdom's `<input type="date">` accepts ISO YYYY-MM-DD via type().
    await user.type(screen.getByTestId('audit-date-from'), '2026-05-24');
    await user.type(screen.getByTestId('audit-date-to'), '2026-05-24');

    await waitFor(() => {
      const lastCall =
        built.auditList.mock.calls[built.auditList.mock.calls.length - 1];
      const req = lastCall?.[0] as
        | { filter?: { dateFrom?: string; dateTo?: string } }
        | undefined;
      expect(req?.filter).toMatchObject({
        dateFrom: '2026-05-24T00:00:00.000Z',
        dateTo: '2026-05-24T23:59:59.999Z',
      });
    });
  });

  it('debounces the userId filter before forwarding', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const built = buildStub([makeAudit(1)]);
    installApi(built.stub);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <AuthProvider initialSession={adminSession}>
        <AuditLogPage />
      </AuthProvider>,
    );

    await vi.waitFor(() => {
      expect(built.auditList).toHaveBeenCalled();
    });
    const initialCalls = built.auditList.mock.calls.length;

    await user.type(screen.getByTestId('audit-user-id'), 'u-x');
    // Mid-debounce: no new call yet.
    expect(built.auditList.mock.calls.length).toBe(initialCalls);

    // Advance past the local 250ms debounce + table's internal 250ms.
    await vi.advanceTimersByTimeAsync(600);

    await vi.waitFor(() => {
      const post = built.auditList.mock.calls.length;
      expect(post).toBeGreaterThan(initialCalls);
      const lastCall = built.auditList.mock.calls[post - 1];
      const req = lastCall?.[0] as { filter?: { userId?: string } } | undefined;
      expect(req?.filter?.userId).toBe('u-x');
    });
  });
});
