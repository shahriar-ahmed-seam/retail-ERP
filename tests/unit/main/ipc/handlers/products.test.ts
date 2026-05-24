import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the products IPC handler group (Phase 4, task 4.2).
 *
 * Drives each channel through `invokeHandlerForTest` — the same code
 * path Electron's `ipcMain.handle` uses in production — so the
 * assertions cover the full middleware chain (auth + RBAC + audit +
 * handler), not just the handler bodies.
 *
 * Critically, this means we exercise the static RBAC matrix end-to-end:
 *   - admin sessions can call all three channels,
 *   - cashier sessions can call `products:list` and `products:count`
 *     (read-only access per Req 2 / 8.3),
 *   - cashier sessions are denied on `products:upsert` with
 *     `FORBIDDEN`, and the denial path emits an `rbac.deny` audit row
 *     (Req 8.4).
 *
 * `@main/services/product.service` is mocked so the service surface is
 * deterministic and the audit-row count is not polluted by domain-level
 * Prisma writes.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 8.4.
 */

// ---------------------------------------------------------------------------
// ProductService mock
// ---------------------------------------------------------------------------

const productMock = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  getById: vi.fn(),
  getByBarcode: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@main/services/product.service', () => ({
  ProductService: productMock,
}));

vi.mock('@main/services/product.service.js', () => ({
  ProductService: productMock,
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerProductsHandlers } from '@main/ipc/handlers/products';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { ProductDTO, ProductInput } from '@shared/dto/index';

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

function makeProductDTO(overrides: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: overrides.id ?? 'prod-1',
    sku: overrides.sku ?? 'SKU-1',
    name: overrides.name ?? 'Hammer',
    categoryId: overrides.categoryId ?? 'cat-1',
    barcode: overrides.barcode ?? null,
    buyPrice: overrides.buyPrice ?? '10',
    sellPrice: overrides.sellPrice ?? '15',
    taxRate: overrides.taxRate ?? '0',
    warrantyMonths: overrides.warrantyMonths ?? 0,
    reorderLevel: overrides.reorderLevel ?? 0,
    onHand: overrides.onHand ?? 0,
  };
}

const sampleInput: ProductInput = {
  sku: 'SKU-NEW',
  name: 'New Item',
  categoryId: 'cat-1',
  buyPrice: '10',
  sellPrice: '15',
  taxRate: '0',
  warrantyMonths: 0,
  reorderLevel: 0,
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  productMock.list.mockReset();
  productMock.count.mockReset();
  productMock.getById.mockReset();
  productMock.getByBarcode.mockReset();
  productMock.upsert.mockReset();

  registerProductsHandlers();
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

describe('registerProductsHandlers', () => {
  it('registers all three channels: list, count, upsert', () => {
    expect(hasHandler('products:list')).toBe(true);
    expect(hasHandler('products:count')).toBe(true);
    expect(hasHandler('products:upsert')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerProductsHandlers();
    }).not.toThrow();
    expect(hasHandler('products:list')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate (default `requiresAuth: true`)
// ---------------------------------------------------------------------------

describe('products:* require an authenticated session', () => {
  it.each([
    ['products:list' as const, {}],
    ['products:count' as const, {}],
    ['products:upsert' as const, sampleInput as unknown as Record<string, unknown>],
  ])('%s returns UNAUTHENTICATED with no session', async (channel, payload) => {
    const result = await invokeHandlerForTest(channel, ADMIN_SENDER, payload as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(productMock.list).not.toHaveBeenCalled();
    expect(productMock.count).not.toHaveBeenCalled();
    expect(productMock.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// products:list — Admin and Cashier both allowed (Req 2.x, 8.3)
// ---------------------------------------------------------------------------

describe('products:list handler', () => {
  it('Admin can call it and receives the list response envelope', async () => {
    const rows = [makeProductDTO({ id: 'p-1' }), makeProductDTO({ id: 'p-2' })];
    productMock.list.mockResolvedValue(Ok({ rows, nextCursor: null }));
    bindAdmin();

    const result = await invokeHandlerForTest('products:list', ADMIN_SENDER, { pageSize: 50 });

    expect(productMock.list).toHaveBeenCalledTimes(1);
    expect(productMock.list).toHaveBeenCalledWith({ pageSize: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual(rows);
      expect(result.value.nextCursor).toBeNull();
    }
  });

  it('Cashier can also call it (read-only access per Req 8.3)', async () => {
    productMock.list.mockResolvedValue(Ok({ rows: [], nextCursor: null }));
    bindCashier();

    const result = await invokeHandlerForTest('products:list', CASHIER_SENDER, {});

    expect(result.ok).toBe(true);
    expect(productMock.list).toHaveBeenCalledTimes(1);
    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
  });

  it('forwards the request envelope (filter, search, sort, cursor, pageSize, withCount) untouched', async () => {
    productMock.list.mockResolvedValue(Ok({ rows: [], nextCursor: null }));
    bindAdmin();

    const req = {
      filter: { categoryId: 'cat-1', lowStockOnly: true },
      search: 'led',
      sort: { key: 'name' as const, dir: 'asc' as const },
      cursor: 'opaque-cursor-token',
      pageSize: 100,
      withCount: true,
    };
    await invokeHandlerForTest('products:list', ADMIN_SENDER, req);
    expect(productMock.list).toHaveBeenCalledWith(req);
  });

  it('forwards VALIDATION envelopes (e.g. malformed cursor) unchanged', async () => {
    productMock.list.mockResolvedValue(Err('VALIDATION', { field: 'cursor' }));
    bindAdmin();

    const result = await invokeHandlerForTest('products:list', ADMIN_SENDER, {
      cursor: 'not-base64!!',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'cursor' });
    }
  });
});

// ---------------------------------------------------------------------------
// products:count — Admin and Cashier both allowed
// ---------------------------------------------------------------------------

describe('products:count handler', () => {
  it('Admin receives the totalCount envelope', async () => {
    productMock.count.mockResolvedValue(Ok({ totalCount: 42 }));
    bindAdmin();

    const result = await invokeHandlerForTest('products:count', ADMIN_SENDER, {});
    expect(productMock.count).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ totalCount: 42 });
    }
  });

  it('Cashier can also call count', async () => {
    productMock.count.mockResolvedValue(Ok({ totalCount: 0 }));
    bindCashier();

    const result = await invokeHandlerForTest('products:count', CASHIER_SENDER, {
      filter: { categoryId: 'cat-1' },
    });
    expect(result.ok).toBe(true);
    expect(productMock.count).toHaveBeenCalledWith({ filter: { categoryId: 'cat-1' } });
    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// products:upsert — Admin only (Req 2.4, 8.3)
// ---------------------------------------------------------------------------

describe('products:upsert handler', () => {
  it('Admin can call it and receives the upserted DTO', async () => {
    const dto = makeProductDTO({ id: 'p-new' });
    productMock.upsert.mockResolvedValue(Ok(dto));
    bindAdmin();

    const result = await invokeHandlerForTest('products:upsert', ADMIN_SENDER, sampleInput);

    expect(productMock.upsert).toHaveBeenCalledWith(sampleInput, { userId: 'u-admin' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(dto);
    }
  });

  it('passes the acting userId from the session into the service ctx', async () => {
    productMock.upsert.mockResolvedValue(Ok(makeProductDTO()));
    sessionStore.bind(ADMIN_SENDER, {
      userId: 'u-owner-42',
      role: 'Admin',
      sessionId: 's-owner',
      createdAt: new Date(),
    });

    await invokeHandlerForTest('products:upsert', ADMIN_SENDER, sampleInput);
    expect(productMock.upsert).toHaveBeenCalledWith(sampleInput, { userId: 'u-owner-42' });
  });

  it('forwards UNIQUE_VIOLATION envelopes from the service unchanged', async () => {
    productMock.upsert.mockResolvedValue(Err('UNIQUE_VIOLATION', { field: 'sku' }));
    bindAdmin();

    const result = await invokeHandlerForTest('products:upsert', ADMIN_SENDER, sampleInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNIQUE_VIOLATION');
      expect(result.error.details).toEqual({ field: 'sku' });
    }
  });

  it('forwards FK_VIOLATION envelopes (categoryId, not_found) unchanged', async () => {
    productMock.upsert.mockResolvedValue(Err('FK_VIOLATION', { field: 'categoryId' }));
    bindAdmin();

    const result = await invokeHandlerForTest('products:upsert', ADMIN_SENDER, sampleInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ field: 'categoryId' });
    }
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('products:upsert', CASHIER_SENDER, sampleInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'products:upsert' });
    }
    expect(productMock.upsert).not.toHaveBeenCalled();

    const denyRow = recorder.rows.find((r) => r.actionType === 'rbac.deny');
    expect(denyRow).toBeDefined();
    expect(denyRow?.entityId).toBe('products:upsert');
    expect(denyRow?.userId).toBe('u-cashier');
  });
});
