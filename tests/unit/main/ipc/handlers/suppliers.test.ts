import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the suppliers IPC handler group (Phase 6, task 6.1).
 *
 * Drives each channel through `invokeHandlerForTest` so the assertions
 * cover the full middleware chain (auth + RBAC + handler).
 *
 * All four supplier channels are ADMIN_ONLY per the static matrix —
 * cashiers see `Err('FORBIDDEN')` from the router and an `rbac.deny`
 * audit row is written before this handler runs (Req 8.4).
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 8.2, 8.4.
 */

// ---------------------------------------------------------------------------
// SupplierService mock
// ---------------------------------------------------------------------------

const supplierMock = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  upsert: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('@main/services/supplier.service', () => ({
  SupplierService: supplierMock,
}));

vi.mock('@main/services/supplier.service.js', () => ({
  SupplierService: supplierMock,
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerSuppliersHandlers } from '@main/ipc/handlers/suppliers';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { SupplierDTO, SupplierInput } from '@shared/dto/index';

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

function makeSupplierDTO(overrides: Partial<SupplierDTO> = {}): SupplierDTO {
  return {
    id: overrides.id ?? 'sup-1',
    name: overrides.name ?? 'Acme',
    phone: overrides.phone ?? null,
    address: overrides.address ?? null,
  };
}

const sampleInput: SupplierInput = {
  name: 'Acme',
  phone: '555-0',
  address: '1 Main St',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  supplierMock.list.mockReset();
  supplierMock.count.mockReset();
  supplierMock.upsert.mockReset();
  supplierMock.detail.mockReset();

  registerSuppliersHandlers();
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

describe('registerSuppliersHandlers', () => {
  it('registers all four channels: list, count, upsert, detail', () => {
    expect(hasHandler('suppliers:list')).toBe(true);
    expect(hasHandler('suppliers:count')).toBe(true);
    expect(hasHandler('suppliers:upsert')).toBe(true);
    expect(hasHandler('suppliers:detail')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerSuppliersHandlers();
    }).not.toThrow();
    expect(hasHandler('suppliers:list')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('suppliers:* require an authenticated session', () => {
  it.each([
    ['suppliers:list' as const, {}],
    ['suppliers:count' as const, {}],
    ['suppliers:upsert' as const, sampleInput as unknown as Record<string, unknown>],
    ['suppliers:detail' as const, { id: 'sup-1' }],
  ])('%s returns UNAUTHENTICATED with no session', async (channel, payload) => {
    const result = await invokeHandlerForTest(channel, ADMIN_SENDER, payload as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(supplierMock.list).not.toHaveBeenCalled();
    expect(supplierMock.count).not.toHaveBeenCalled();
    expect(supplierMock.upsert).not.toHaveBeenCalled();
    expect(supplierMock.detail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// suppliers:list — Admin path
// ---------------------------------------------------------------------------

describe('suppliers:list handler', () => {
  it('Admin can call it and receives the list response envelope', async () => {
    const rows = [makeSupplierDTO({ id: 's-1' }), makeSupplierDTO({ id: 's-2' })];
    supplierMock.list.mockResolvedValue(Ok({ rows, nextCursor: null }));
    bindAdmin();

    const result = await invokeHandlerForTest('suppliers:list', ADMIN_SENDER, { pageSize: 50 });

    expect(supplierMock.list).toHaveBeenCalledTimes(1);
    expect(supplierMock.list).toHaveBeenCalledWith({ pageSize: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual(rows);
      expect(result.value.nextCursor).toBeNull();
    }
  });

  it('forwards the request envelope (search, sort, cursor, pageSize, withCount) untouched', async () => {
    supplierMock.list.mockResolvedValue(Ok({ rows: [], nextCursor: null }));
    bindAdmin();

    const req = {
      search: 'acme',
      sort: { key: 'name' as const, dir: 'asc' as const },
      cursor: 'opaque-cursor-token',
      pageSize: 100,
      withCount: true,
    };
    await invokeHandlerForTest('suppliers:list', ADMIN_SENDER, req);
    expect(supplierMock.list).toHaveBeenCalledWith(req);
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('suppliers:list', CASHIER_SENDER, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'suppliers:list' });
    }
    expect(supplierMock.list).not.toHaveBeenCalled();

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'suppliers:list',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });
});

// ---------------------------------------------------------------------------
// suppliers:count — Admin path
// ---------------------------------------------------------------------------

describe('suppliers:count handler', () => {
  it('Admin receives the totalCount envelope', async () => {
    supplierMock.count.mockResolvedValue(Ok({ totalCount: 42 }));
    bindAdmin();

    const result = await invokeHandlerForTest('suppliers:count', ADMIN_SENDER, {});
    expect(supplierMock.count).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ totalCount: 42 });
    }
  });

  it('Cashier is denied with FORBIDDEN', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('suppliers:count', CASHIER_SENDER, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
    expect(supplierMock.count).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// suppliers:upsert — Admin only
// ---------------------------------------------------------------------------

describe('suppliers:upsert handler', () => {
  it('Admin can call it and receives the upserted DTO', async () => {
    const dto = makeSupplierDTO({ id: 's-new' });
    supplierMock.upsert.mockResolvedValue(Ok(dto));
    bindAdmin();

    const result = await invokeHandlerForTest('suppliers:upsert', ADMIN_SENDER, sampleInput);

    expect(supplierMock.upsert).toHaveBeenCalledWith(sampleInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(dto);
    }
  });

  it('forwards VALIDATION envelopes from the service unchanged', async () => {
    supplierMock.upsert.mockResolvedValue(Err('VALIDATION', { field: 'name' }));
    bindAdmin();

    const result = await invokeHandlerForTest('suppliers:upsert', ADMIN_SENDER, sampleInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'name' });
    }
  });

  it('forwards FK_VIOLATION envelopes (unknown id on update) unchanged', async () => {
    supplierMock.upsert.mockResolvedValue(Err('FK_VIOLATION', { reason: 'not_found' }));
    bindAdmin();

    const result = await invokeHandlerForTest('suppliers:upsert', ADMIN_SENDER, {
      ...sampleInput,
      id: 'gone',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('suppliers:upsert', CASHIER_SENDER, sampleInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'suppliers:upsert' });
    }
    expect(supplierMock.upsert).not.toHaveBeenCalled();

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'suppliers:upsert',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });
});

// ---------------------------------------------------------------------------
// suppliers:detail — Admin only
// ---------------------------------------------------------------------------

describe('suppliers:detail handler', () => {
  it('Admin can call it and receives the supplier + history envelope', async () => {
    const supplier = makeSupplierDTO({ id: 's-1' });
    const history = { rows: [], nextCursor: null };
    supplierMock.detail.mockResolvedValue(Ok({ supplier, history }));
    bindAdmin();

    const result = await invokeHandlerForTest('suppliers:detail', ADMIN_SENDER, {
      id: 's-1',
    });
    expect(supplierMock.detail).toHaveBeenCalledWith({ id: 's-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.supplier).toEqual(supplier);
      expect(result.value.history).toEqual(history);
    }
  });

  it('forwards the history sub-envelope (cursor, pageSize, withCount) untouched', async () => {
    supplierMock.detail.mockResolvedValue(
      Ok({ supplier: makeSupplierDTO(), history: { rows: [], nextCursor: null } }),
    );
    bindAdmin();

    const req = {
      id: 's-1',
      history: { pageSize: 20, withCount: true, cursor: 'tok' },
    };
    await invokeHandlerForTest('suppliers:detail', ADMIN_SENDER, req);
    expect(supplierMock.detail).toHaveBeenCalledWith(req);
  });

  it('forwards FK_VIOLATION envelopes (unknown supplier) unchanged', async () => {
    supplierMock.detail.mockResolvedValue(Err('FK_VIOLATION', { reason: 'not_found' }));
    bindAdmin();

    const result = await invokeHandlerForTest('suppliers:detail', ADMIN_SENDER, {
      id: 'gone',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('suppliers:detail', CASHIER_SENDER, {
      id: 's-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'suppliers:detail' });
    }
    expect(supplierMock.detail).not.toHaveBeenCalled();

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'suppliers:detail',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });
});
