import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the inventory IPC handler group (Phase 5, task 5.2).
 *
 * Drives `inventory:adjust` through `invokeHandlerForTest` — the same
 * code path Electron's `ipcMain.handle` uses in production — so the
 * assertions cover the full middleware chain (auth + RBAC + handler),
 * not just the handler body.
 *
 * Critically, this means we exercise the static RBAC matrix end-to-end:
 *   - admin sessions can call the channel and the upserted DTO is
 *     returned,
 *   - cashier sessions are denied with `FORBIDDEN`, the service is
 *     never invoked, AND the denial path emits an `rbac.deny` audit
 *     row (Req 8.4),
 *   - missing sessions return `UNAUTHENTICATED`.
 *
 * `@main/services/inventory.service` is mocked so the service surface
 * is deterministic and the audit-row count is not polluted by the
 * domain-level audit row the real `adjust` would write.
 *
 * Validates: Requirements 3.5, 8.2, 8.4, 13.3, 13.4.
 */

// ---------------------------------------------------------------------------
// InventoryService mock
// ---------------------------------------------------------------------------

const inventoryMock = vi.hoisted(() => ({
  applyMovement: vi.fn(),
  adjust: vi.fn(),
  lowStockCount: vi.fn(),
  lowStockList: vi.fn(),
  listMovements: vi.fn(),
  countMovements: vi.fn(),
}));

vi.mock('@main/services/inventory.service', () => ({
  InventoryService: inventoryMock,
  applyMovement: inventoryMock.applyMovement,
  // Re-export `OutOfStockError` from the real module so any
  // `instanceof` checks in production code keep working. The handler
  // itself does not import `OutOfStockError`, but the service barrel
  // does, and a partial mock would otherwise drop the export.
  OutOfStockError: class OutOfStockError extends Error {},
}));

vi.mock('@main/services/inventory.service.js', () => ({
  InventoryService: inventoryMock,
  applyMovement: inventoryMock.applyMovement,
  OutOfStockError: class OutOfStockError extends Error {},
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerInventoryHandlers } from '@main/ipc/handlers/inventory';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { AdjustmentInput } from '@shared/dto/index';

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

function bindAdmin(): void {
  sessionStore.bind(ADMIN_SENDER, {
    userId: 'u-admin',
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

const sampleInput: AdjustmentInput = {
  productId: 'prod-1',
  quantityDelta: 3,
  reason: 'Cycle count',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  inventoryMock.applyMovement.mockReset();
  inventoryMock.adjust.mockReset();
  inventoryMock.lowStockCount.mockReset();
  inventoryMock.lowStockList.mockReset();
  inventoryMock.listMovements.mockReset();
  inventoryMock.countMovements.mockReset();

  registerInventoryHandlers();
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

describe('registerInventoryHandlers', () => {
  it('registers the inventory:adjust channel', () => {
    expect(hasHandler('inventory:adjust')).toBe(true);
  });

  it('registers the inventory:lowStockCount channel', () => {
    expect(hasHandler('inventory:lowStockCount')).toBe(true);
  });

  it('registers the inventory_movements:list channel', () => {
    expect(hasHandler('inventory_movements:list')).toBe(true);
  });

  it('registers the inventory_movements:count channel', () => {
    expect(hasHandler('inventory_movements:count')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerInventoryHandlers();
    }).not.toThrow();
    expect(hasHandler('inventory:adjust')).toBe(true);
    expect(hasHandler('inventory:lowStockCount')).toBe(true);
    expect(hasHandler('inventory_movements:list')).toBe(true);
    expect(hasHandler('inventory_movements:count')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate (default `requiresAuth: true`)
// ---------------------------------------------------------------------------

describe('inventory:adjust requires an authenticated session', () => {
  it('returns UNAUTHENTICATED with no session bound', async () => {
    const result = await invokeHandlerForTest(
      'inventory:adjust',
      ADMIN_SENDER,
      sampleInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(inventoryMock.adjust).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// inventory:adjust — Admin path (Req 3.5, 8.2)
// ---------------------------------------------------------------------------

describe('inventory:adjust handler — Admin path', () => {
  it('Admin can call it and receives the { movementId } envelope', async () => {
    inventoryMock.adjust.mockResolvedValue(Ok({ movementId: 'mov-42' }));
    bindAdmin();

    const result = await invokeHandlerForTest(
      'inventory:adjust',
      ADMIN_SENDER,
      sampleInput,
    );

    expect(inventoryMock.adjust).toHaveBeenCalledTimes(1);
    expect(inventoryMock.adjust).toHaveBeenCalledWith(sampleInput, { userId: 'u-admin' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ movementId: 'mov-42' });
    }
  });

  it('passes the acting userId from the session into the service ctx', async () => {
    inventoryMock.adjust.mockResolvedValue(Ok({ movementId: 'mov-1' }));
    sessionStore.bind(ADMIN_SENDER, {
      userId: 'u-owner-42',
      role: 'Admin',
      sessionId: 's-owner',
      createdAt: new Date(),
    });

    await invokeHandlerForTest('inventory:adjust', ADMIN_SENDER, sampleInput);
    expect(inventoryMock.adjust).toHaveBeenCalledWith(sampleInput, { userId: 'u-owner-42' });
  });

  it('forwards OUT_OF_STOCK envelopes from the service unchanged', async () => {
    inventoryMock.adjust.mockResolvedValue(Err('OUT_OF_STOCK', { productId: 'prod-1' }));
    bindAdmin();

    const result = await invokeHandlerForTest('inventory:adjust', ADMIN_SENDER, {
      productId: 'prod-1',
      quantityDelta: -100,
      reason: 'Big mistake',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('OUT_OF_STOCK');
      expect(result.error.details).toEqual({ productId: 'prod-1' });
    }
  });

  it('forwards VALIDATION envelopes (e.g. zero delta) unchanged', async () => {
    inventoryMock.adjust.mockResolvedValue(Err('VALIDATION', { field: 'quantityDelta' }));
    bindAdmin();

    const result = await invokeHandlerForTest('inventory:adjust', ADMIN_SENDER, {
      productId: 'prod-1',
      quantityDelta: 0,
      reason: 'noop',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'quantityDelta' });
    }
  });

  it('forwards FK_VIOLATION envelopes (unknown product) unchanged', async () => {
    inventoryMock.adjust.mockResolvedValue(Err('FK_VIOLATION', { reason: 'not_found' }));
    bindAdmin();

    const result = await invokeHandlerForTest('inventory:adjust', ADMIN_SENDER, {
      productId: 'prod-missing',
      quantityDelta: 1,
      reason: 'Phantom',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });
});

// ---------------------------------------------------------------------------
// inventory:adjust — Cashier denial (Req 8.4)
// ---------------------------------------------------------------------------

describe('inventory:adjust handler — Cashier denial', () => {
  it('Cashier is denied with FORBIDDEN and the service is not invoked', async () => {
    bindCashier();

    const result = await invokeHandlerForTest(
      'inventory:adjust',
      CASHIER_SENDER,
      sampleInput,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'inventory:adjust' });
    }
    expect(inventoryMock.adjust).not.toHaveBeenCalled();
  });

  it('writes an rbac.deny audit row attributing the denial to the cashier', async () => {
    bindCashier();

    await invokeHandlerForTest('inventory:adjust', CASHIER_SENDER, sampleInput);

    const denyRow = recorder.rows.find((r) => r.actionType === 'rbac.deny');
    expect(denyRow).toBeDefined();
    expect(denyRow?.entityType).toBe('ipc');
    expect(denyRow?.entityId).toBe('inventory:adjust');
    expect(denyRow?.userId).toBe('u-cashier');
  });
});


// ---------------------------------------------------------------------------
// inventory:lowStockCount — auth gate (Req 1.5)
// ---------------------------------------------------------------------------

describe('inventory:lowStockCount requires an authenticated session', () => {
  it('returns UNAUTHENTICATED with no session bound', async () => {
    const result = await invokeHandlerForTest('inventory:lowStockCount', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(inventoryMock.lowStockCount).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// inventory:lowStockCount — Admin path (Req 3.6)
// ---------------------------------------------------------------------------

describe('inventory:lowStockCount handler — Admin path', () => {
  it('Admin can call it and receives the { count } envelope', async () => {
    inventoryMock.lowStockCount.mockResolvedValue(Ok({ count: 3 }));
    bindAdmin();

    const result = await invokeHandlerForTest('inventory:lowStockCount', ADMIN_SENDER, undefined);

    expect(inventoryMock.lowStockCount).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ count: 3 });
    }
  });

  it('returns zero counts unchanged from the service envelope', async () => {
    inventoryMock.lowStockCount.mockResolvedValue(Ok({ count: 0 }));
    bindAdmin();

    const result = await invokeHandlerForTest('inventory:lowStockCount', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ count: 0 });
    }
  });
});

// ---------------------------------------------------------------------------
// inventory:lowStockCount — Cashier allowed (Req 3.6, 8.3)
// ---------------------------------------------------------------------------

describe('inventory:lowStockCount handler — Cashier path', () => {
  it('Cashier is allowed by the matrix because the banner is visible to all roles', async () => {
    inventoryMock.lowStockCount.mockResolvedValue(Ok({ count: 5 }));
    bindCashier();

    const result = await invokeHandlerForTest(
      'inventory:lowStockCount',
      CASHIER_SENDER,
      undefined,
    );

    expect(inventoryMock.lowStockCount).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ count: 5 });
    }
  });

  it('does not write an rbac.deny audit row when a Cashier calls it', async () => {
    inventoryMock.lowStockCount.mockResolvedValue(Ok({ count: 0 }));
    bindCashier();

    await invokeHandlerForTest('inventory:lowStockCount', CASHIER_SENDER, undefined);

    const denyRow = recorder.rows.find((r) => r.actionType === 'rbac.deny');
    expect(denyRow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inventory_movements:list — auth gate (Req 1.5)
// ---------------------------------------------------------------------------

describe('inventory_movements:list requires an authenticated session', () => {
  it('returns UNAUTHENTICATED with no session bound', async () => {
    const result = await invokeHandlerForTest('inventory_movements:list', ADMIN_SENDER, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(inventoryMock.listMovements).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// inventory_movements:list — Admin path (Req 3.1, 16.1–16.4)
// ---------------------------------------------------------------------------

describe('inventory_movements:list handler — Admin path', () => {
  it('Admin can call it and receives the ListResponse envelope', async () => {
    const sample = {
      rows: [
        {
          id: 'mov-1',
          productId: 'p-1',
          productName: 'Widget',
          quantityDelta: -1,
          movementType: 'sale' as const,
          referenceType: 'sale' as const,
          referenceId: 'sale-1',
          userId: 'u-admin',
          userName: 'admin',
          timestamp: '2024-01-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    };
    inventoryMock.listMovements.mockResolvedValue(Ok(sample));
    bindAdmin();

    const result = await invokeHandlerForTest('inventory_movements:list', ADMIN_SENDER, {
      pageSize: 50,
    });

    expect(inventoryMock.listMovements).toHaveBeenCalledTimes(1);
    expect(inventoryMock.listMovements).toHaveBeenCalledWith({ pageSize: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(sample);
    }
  });

  it('forwards filter, cursor, sort, withCount unchanged', async () => {
    inventoryMock.listMovements.mockResolvedValue(Ok({ rows: [], nextCursor: null }));
    bindAdmin();

    const req = {
      filter: {
        productId: 'p-1',
        movementType: 'sale' as const,
        dateFrom: '2024-01-01T00:00:00.000Z',
        dateTo: '2024-12-31T23:59:59.999Z',
      },
      sort: { key: 'timestamp' as const, dir: 'desc' as const },
      cursor: 'opaque-token',
      pageSize: 100,
      withCount: true,
    };
    await invokeHandlerForTest('inventory_movements:list', ADMIN_SENDER, req);
    expect(inventoryMock.listMovements).toHaveBeenCalledWith(req);
  });

  it('forwards VALIDATION envelopes (e.g. malformed cursor) unchanged', async () => {
    inventoryMock.listMovements.mockResolvedValue(Err('VALIDATION', { field: 'cursor' }));
    bindAdmin();

    const result = await invokeHandlerForTest('inventory_movements:list', ADMIN_SENDER, {
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
// inventory_movements:list — Cashier denial (Req 8.4)
// ---------------------------------------------------------------------------

describe('inventory_movements:list handler — Cashier denial', () => {
  it('Cashier is denied with FORBIDDEN and the service is not invoked', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('inventory_movements:list', CASHIER_SENDER, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'inventory_movements:list' });
    }
    expect(inventoryMock.listMovements).not.toHaveBeenCalled();
  });

  it('writes an rbac.deny audit row attributing the denial to the cashier', async () => {
    bindCashier();

    await invokeHandlerForTest('inventory_movements:list', CASHIER_SENDER, {});

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'inventory_movements:list',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.entityType).toBe('ipc');
    expect(denyRow?.userId).toBe('u-cashier');
  });
});

// ---------------------------------------------------------------------------
// inventory_movements:count — auth gate
// ---------------------------------------------------------------------------

describe('inventory_movements:count requires an authenticated session', () => {
  it('returns UNAUTHENTICATED with no session bound', async () => {
    const result = await invokeHandlerForTest('inventory_movements:count', ADMIN_SENDER, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(inventoryMock.countMovements).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// inventory_movements:count — Admin path
// ---------------------------------------------------------------------------

describe('inventory_movements:count handler — Admin path', () => {
  it('Admin can call it and receives the { totalCount } envelope', async () => {
    inventoryMock.countMovements.mockResolvedValue(Ok({ totalCount: 42 }));
    bindAdmin();

    const result = await invokeHandlerForTest('inventory_movements:count', ADMIN_SENDER, {});

    expect(inventoryMock.countMovements).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ totalCount: 42 });
    }
  });

  it('forwards { filter, search } verbatim to the service', async () => {
    inventoryMock.countMovements.mockResolvedValue(Ok({ totalCount: 0 }));
    bindAdmin();

    const req = {
      filter: { productId: 'p-1', movementType: 'sale' as const },
      search: 'unused',
    };
    await invokeHandlerForTest('inventory_movements:count', ADMIN_SENDER, req);
    expect(inventoryMock.countMovements).toHaveBeenCalledWith(req);
  });
});

// ---------------------------------------------------------------------------
// inventory_movements:count — Cashier denial (Req 8.4)
// ---------------------------------------------------------------------------

describe('inventory_movements:count handler — Cashier denial', () => {
  it('Cashier is denied with FORBIDDEN and the service is not invoked', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('inventory_movements:count', CASHIER_SENDER, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'inventory_movements:count' });
    }
    expect(inventoryMock.countMovements).not.toHaveBeenCalled();
  });

  it('writes an rbac.deny audit row attributing the denial to the cashier', async () => {
    bindCashier();

    await invokeHandlerForTest('inventory_movements:count', CASHIER_SENDER, {});

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'inventory_movements:count',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });
});
