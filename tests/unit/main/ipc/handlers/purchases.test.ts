import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the purchases IPC handler group (Phase 6, task 6.2).
 *
 * Drives each channel through `invokeHandlerForTest` so the assertions
 * cover the full middleware chain (auth + RBAC + handler).
 *
 * All three purchase channels are ADMIN_ONLY per the static matrix —
 * cashiers see `Err('FORBIDDEN')` from the router and an `rbac.deny`
 * audit row is written before this handler runs (Req 8.4). Admin
 * sessions reach the service and have their `userId` forwarded as
 * `ctx.userId` so the journal payload + each ledger movement
 * attribute the purchase correctly.
 *
 * Validates: Requirements 5.1, 5.5, 8.2, 8.4, 11.2, 16.1, 16.2, 16.3.
 */

// ---------------------------------------------------------------------------
// PurchaseService mock
// ---------------------------------------------------------------------------

const purchaseMock = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@main/services/purchase.service', () => ({
  PurchaseService: purchaseMock,
}));

vi.mock('@main/services/purchase.service.js', () => ({
  PurchaseService: purchaseMock,
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerPurchasesHandlers } from '@main/ipc/handlers/purchases';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { PurchaseInput, PurchaseSummaryDTO } from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Recording audit writer
// ---------------------------------------------------------------------------

class RecordingAuditWriter implements AuditWriter {
  public readonly rows: AuditWriteInput[] = [];
  public write(input: AuditWriteInput): Promise<void> {
    this.rows.push(input);
    return Promise.resolve();
  }
}

let recorder: RecordingAuditWriter;
const ADMIN_SENDER = 100;
const CASHIER_SENDER = 200;

function bindAdmin(userId = 'u-admin'): void {
  sessionStore.bind(ADMIN_SENDER, {
    userId,
    role: 'Admin',
    sessionId: 's-admin',
    createdAt: new Date(),
  });
}

function bindCashier(): void {
  sessionStore.bind(CASHIER_SENDER, {
    userId: 'u-cashier',
    role: 'Cashier',
    sessionId: 's-cashier',
    createdAt: new Date(),
  });
}

function makeSummary(overrides: Partial<PurchaseSummaryDTO> = {}): PurchaseSummaryDTO {
  return {
    id: overrides.id ?? 'pur-1',
    supplierId: overrides.supplierId ?? 'sup-1',
    supplierName: overrides.supplierName ?? 'Acme',
    invoiceNo: overrides.invoiceNo ?? null,
    total: overrides.total ?? '10.00',
    itemCount: overrides.itemCount ?? 1,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
  };
}

const sampleInput: PurchaseInput = {
  supplierId: 'sup-1',
  invoiceNo: 'INV-1',
  items: [{ productId: 'p-1', quantity: 2, unitBuyPrice: '10.00' }],
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  purchaseMock.create.mockReset();
  purchaseMock.list.mockReset();
  purchaseMock.count.mockReset();

  registerPurchasesHandlers();
});

afterEach(() => {
  resetAuditWriter();
  clearHandlers();
  sessionStore.clearAll();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

describe('registerPurchasesHandlers', () => {
  it('registers purchase:create, purchases:list, and purchases:count', () => {
    expect(hasHandler('purchase:create')).toBe(true);
    expect(hasHandler('purchases:list')).toBe(true);
    expect(hasHandler('purchases:count')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerPurchasesHandlers();
    }).not.toThrow();
    expect(hasHandler('purchase:create')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('purchases:* require an authenticated session', () => {
  it('purchase:create returns UNAUTHENTICATED with no session', async () => {
    const result = await invokeHandlerForTest('purchase:create', ADMIN_SENDER, sampleInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(purchaseMock.create).not.toHaveBeenCalled();
  });

  it('purchases:list returns UNAUTHENTICATED with no session', async () => {
    const result = await invokeHandlerForTest('purchases:list', ADMIN_SENDER, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(purchaseMock.list).not.toHaveBeenCalled();
  });

  it('purchases:count returns UNAUTHENTICATED with no session', async () => {
    const result = await invokeHandlerForTest('purchases:count', ADMIN_SENDER, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(purchaseMock.count).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// purchase:create — Admin path (Req 5.1, 8.2, 11.2)
// ---------------------------------------------------------------------------

describe('purchase:create handler — Admin path', () => {
  it('Admin can call it and receives the { purchaseId } envelope', async () => {
    purchaseMock.create.mockResolvedValue(Ok({ purchaseId: 'pur-42' }));
    bindAdmin();

    const result = await invokeHandlerForTest('purchase:create', ADMIN_SENDER, sampleInput);

    expect(purchaseMock.create).toHaveBeenCalledTimes(1);
    expect(purchaseMock.create).toHaveBeenCalledWith(sampleInput, { userId: 'u-admin' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ purchaseId: 'pur-42' });
    }
  });

  it('forwards the acting userId from the session into the service ctx', async () => {
    purchaseMock.create.mockResolvedValue(Ok({ purchaseId: 'pur-1' }));
    bindAdmin('u-owner-42');

    await invokeHandlerForTest('purchase:create', ADMIN_SENDER, sampleInput);
    expect(purchaseMock.create).toHaveBeenCalledWith(sampleInput, { userId: 'u-owner-42' });
  });

  it('forwards VALIDATION envelopes (e.g. empty items) unchanged', async () => {
    purchaseMock.create.mockResolvedValue(Err('VALIDATION', { field: 'items' }));
    bindAdmin();

    const result = await invokeHandlerForTest('purchase:create', ADMIN_SENDER, {
      ...sampleInput,
      items: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'items' });
    }
  });

  it('forwards FK_VIOLATION envelopes (unknown supplier or product) unchanged', async () => {
    purchaseMock.create.mockResolvedValue(Err('FK_VIOLATION', { reason: 'not_found' }));
    bindAdmin();

    const result = await invokeHandlerForTest('purchase:create', ADMIN_SENDER, sampleInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });
});

// ---------------------------------------------------------------------------
// purchase:create — Cashier denial (Req 8.4)
// ---------------------------------------------------------------------------

describe('purchase:create handler — Cashier denial', () => {
  it('Cashier is denied with FORBIDDEN and the service is not invoked', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('purchase:create', CASHIER_SENDER, sampleInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'purchase:create' });
    }
    expect(purchaseMock.create).not.toHaveBeenCalled();
  });

  it('writes an rbac.deny audit row attributing the denial to the cashier', async () => {
    bindCashier();

    await invokeHandlerForTest('purchase:create', CASHIER_SENDER, sampleInput);

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'purchase:create',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.entityType).toBe('ipc');
    expect(denyRow?.userId).toBe('u-cashier');
  });
});

// ---------------------------------------------------------------------------
// purchases:list — Admin path
// ---------------------------------------------------------------------------

describe('purchases:list handler — Admin path', () => {
  it('Admin can call it and receives the ListResponse envelope', async () => {
    const rows = [makeSummary({ id: 'pur-1' }), makeSummary({ id: 'pur-2' })];
    purchaseMock.list.mockResolvedValue(Ok({ rows, nextCursor: null }));
    bindAdmin();

    const result = await invokeHandlerForTest('purchases:list', ADMIN_SENDER, { pageSize: 50 });

    expect(purchaseMock.list).toHaveBeenCalledTimes(1);
    expect(purchaseMock.list).toHaveBeenCalledWith({ pageSize: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual(rows);
      expect(result.value.nextCursor).toBeNull();
    }
  });

  it('forwards filter, cursor, sort, withCount unchanged', async () => {
    purchaseMock.list.mockResolvedValue(Ok({ rows: [], nextCursor: null }));
    bindAdmin();

    const req = {
      filter: {
        supplierId: 'sup-1',
        dateFrom: '2024-01-01T00:00:00.000Z',
        dateTo: '2024-12-31T23:59:59.999Z',
      },
      sort: { key: 'createdAt' as const, dir: 'desc' as const },
      cursor: 'opaque-token',
      pageSize: 100,
      withCount: true,
    };
    await invokeHandlerForTest('purchases:list', ADMIN_SENDER, req);
    expect(purchaseMock.list).toHaveBeenCalledWith(req);
  });

  it('forwards VALIDATION envelopes (e.g. malformed cursor) unchanged', async () => {
    purchaseMock.list.mockResolvedValue(Err('VALIDATION', { field: 'cursor' }));
    bindAdmin();

    const result = await invokeHandlerForTest('purchases:list', ADMIN_SENDER, {
      cursor: 'bad',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'cursor' });
    }
  });
});

// ---------------------------------------------------------------------------
// purchases:list — Cashier denial
// ---------------------------------------------------------------------------

describe('purchases:list handler — Cashier denial', () => {
  it('Cashier is denied with FORBIDDEN and the service is not invoked', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('purchases:list', CASHIER_SENDER, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'purchases:list' });
    }
    expect(purchaseMock.list).not.toHaveBeenCalled();
  });

  it('writes an rbac.deny audit row attributing the denial to the cashier', async () => {
    bindCashier();

    await invokeHandlerForTest('purchases:list', CASHIER_SENDER, {});

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'purchases:list',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });
});

// ---------------------------------------------------------------------------
// purchases:count — Admin path
// ---------------------------------------------------------------------------

describe('purchases:count handler — Admin path', () => {
  it('Admin can call it and receives the { totalCount } envelope', async () => {
    purchaseMock.count.mockResolvedValue(Ok({ totalCount: 42 }));
    bindAdmin();

    const result = await invokeHandlerForTest('purchases:count', ADMIN_SENDER, {});

    expect(purchaseMock.count).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ totalCount: 42 });
    }
  });

  it('forwards { filter, search } verbatim to the service', async () => {
    purchaseMock.count.mockResolvedValue(Ok({ totalCount: 0 }));
    bindAdmin();

    const req = {
      filter: { supplierId: 'sup-1' },
      search: 'unused',
    };
    await invokeHandlerForTest('purchases:count', ADMIN_SENDER, req);
    expect(purchaseMock.count).toHaveBeenCalledWith(req);
  });
});

// ---------------------------------------------------------------------------
// purchases:count — Cashier denial
// ---------------------------------------------------------------------------

describe('purchases:count handler — Cashier denial', () => {
  it('Cashier is denied with FORBIDDEN and the service is not invoked', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('purchases:count', CASHIER_SENDER, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'purchases:count' });
    }
    expect(purchaseMock.count).not.toHaveBeenCalled();
  });

  it('writes an rbac.deny audit row attributing the denial to the cashier', async () => {
    bindCashier();

    await invokeHandlerForTest('purchases:count', CASHIER_SENDER, {});

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'purchases:count',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });
});
