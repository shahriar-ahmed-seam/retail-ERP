import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the reports IPC handler group (Phase 5, task 5.3).
 *
 * Drives `reports:lowStock` through `invokeHandlerForTest` — the same
 * code path Electron's `ipcMain.handle` uses in production — so the
 * assertions cover the full middleware chain (auth + RBAC + handler),
 * not just the handler body.
 *
 * The matrix grants both Admin and Cashier on this channel because
 * the persistent `<LowStockBanner>` (design.md > "POS UI") is
 * visible on every screen for both roles and clicking it opens the
 * low-stock report. The tests assert:
 *   - admin sessions can call the channel and receive the rows,
 *   - cashier sessions can call it too (no FORBIDDEN, no rbac.deny
 *     audit row),
 *   - missing sessions return UNAUTHENTICATED before the service is
 *     touched.
 *
 * `@main/services/inventory.service` is mocked so the service
 * surface is deterministic; the unit-level coverage of the actual
 * SQL projection lives in
 * `tests/unit/main/services/inventory.service.test.ts`.
 *
 * Validates: Requirements 3.6, 8.3, 8.4, 9.3.
 */

// ---------------------------------------------------------------------------
// InventoryService mock
// ---------------------------------------------------------------------------

const inventoryMock = vi.hoisted(() => ({
  applyMovement: vi.fn(),
  adjust: vi.fn(),
  lowStockCount: vi.fn(),
  lowStockList: vi.fn(),
}));

vi.mock('@main/services/inventory.service', () => ({
  InventoryService: inventoryMock,
  applyMovement: inventoryMock.applyMovement,
  // Keep the OutOfStockError export so a partial mock does not drop
  // it; the reports handler does not touch it but the service barrel
  // re-exports it and other test files in the same suite import it.
  OutOfStockError: class OutOfStockError extends Error {},
}));

vi.mock('@main/services/inventory.service.js', () => ({
  InventoryService: inventoryMock,
  applyMovement: inventoryMock.applyMovement,
  OutOfStockError: class OutOfStockError extends Error {},
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerReportsHandlers } from '@main/ipc/handlers/reports';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { LowStockRow } from '@shared/ipc-contract';

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

const sampleRows: readonly LowStockRow[] = Object.freeze([
  Object.freeze({
    productId: 'p-1',
    sku: 'SKU-1',
    name: 'Widget',
    onHand: 1,
    reorderLevel: 5,
  }),
  Object.freeze({
    productId: 'p-2',
    sku: 'SKU-2',
    name: 'Gadget',
    onHand: 0,
    reorderLevel: 3,
  }),
]);

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

  registerReportsHandlers();
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

describe('registerReportsHandlers', () => {
  it('registers the reports:lowStock channel', () => {
    expect(hasHandler('reports:lowStock')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerReportsHandlers();
    }).not.toThrow();
    expect(hasHandler('reports:lowStock')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate (default `requiresAuth: true`)
// ---------------------------------------------------------------------------

describe('reports:lowStock requires an authenticated session', () => {
  it('returns UNAUTHENTICATED with no session bound', async () => {
    const result = await invokeHandlerForTest('reports:lowStock', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(inventoryMock.lowStockList).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Admin path (Req 3.6, 9.3)
// ---------------------------------------------------------------------------

describe('reports:lowStock handler — Admin path', () => {
  it('Admin can call it and receives the { rows } envelope', async () => {
    inventoryMock.lowStockList.mockResolvedValue(Ok({ rows: sampleRows }));
    bindAdmin();

    const result = await invokeHandlerForTest('reports:lowStock', ADMIN_SENDER, undefined);

    expect(inventoryMock.lowStockList).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual(sampleRows);
    }
  });

  it('forwards an empty row list unchanged', async () => {
    inventoryMock.lowStockList.mockResolvedValue(Ok({ rows: [] }));
    bindAdmin();

    const result = await invokeHandlerForTest('reports:lowStock', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Cashier path (Req 3.6, 8.3)
// ---------------------------------------------------------------------------

describe('reports:lowStock handler — Cashier path', () => {
  it('Cashier is allowed by the matrix because the banner is visible to all roles', async () => {
    inventoryMock.lowStockList.mockResolvedValue(Ok({ rows: sampleRows }));
    bindCashier();

    const result = await invokeHandlerForTest('reports:lowStock', CASHIER_SENDER, undefined);

    expect(inventoryMock.lowStockList).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual(sampleRows);
    }
  });

  it('does not write an rbac.deny audit row when a Cashier calls it', async () => {
    inventoryMock.lowStockList.mockResolvedValue(Ok({ rows: [] }));
    bindCashier();

    await invokeHandlerForTest('reports:lowStock', CASHIER_SENDER, undefined);

    const denyRow = recorder.rows.find((r) => r.actionType === 'rbac.deny');
    expect(denyRow).toBeUndefined();
  });
});
