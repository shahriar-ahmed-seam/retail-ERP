import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the customers IPC handler group (Phase 9, task 9.1).
 *
 * Drives each channel through `invokeHandlerForTest` so the assertions
 * cover the full middleware chain (auth + RBAC + handler).
 *
 * All four customer channels are ALL_ROLES per the static matrix —
 * cashiers attach customers to sales (Req 7.2) and look up prior
 * purchases (Req 7.3). This means there is no RBAC denial path on
 * the customer surface; the gate tested here is the auth gate
 * (UNAUTHENTICATED with no session).
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 8.4.
 */

// ---------------------------------------------------------------------------
// CustomerService mock
// ---------------------------------------------------------------------------

const customerMock = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  upsert: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('@main/services/customer.service', () => ({
  CustomerService: customerMock,
}));

vi.mock('@main/services/customer.service.js', () => ({
  CustomerService: customerMock,
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerCustomersHandlers } from '@main/ipc/handlers/customers';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { CustomerDTO, CustomerInput } from '@shared/dto/index';

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

function makeCustomerDTO(overrides: Partial<CustomerDTO> = {}): CustomerDTO {
  return {
    id: overrides.id ?? 'cus-1',
    name: overrides.name ?? 'Alice',
    phone: overrides.phone ?? null,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
  };
}

const sampleInput: CustomerInput = {
  name: 'Alice',
  phone: '555-0',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  customerMock.list.mockReset();
  customerMock.count.mockReset();
  customerMock.upsert.mockReset();
  customerMock.detail.mockReset();

  registerCustomersHandlers();
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

describe('registerCustomersHandlers', () => {
  it('registers all four channels: list, count, upsert, detail', () => {
    expect(hasHandler('customers:list')).toBe(true);
    expect(hasHandler('customers:count')).toBe(true);
    expect(hasHandler('customers:upsert')).toBe(true);
    expect(hasHandler('customers:detail')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerCustomersHandlers();
    }).not.toThrow();
    expect(hasHandler('customers:list')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('customers:* require an authenticated session', () => {
  it.each([
    ['customers:list' as const, {}],
    ['customers:count' as const, {}],
    ['customers:upsert' as const, sampleInput as unknown as Record<string, unknown>],
    ['customers:detail' as const, { id: 'cus-1' }],
  ])('%s returns UNAUTHENTICATED with no session', async (channel, payload) => {
    const result = await invokeHandlerForTest(channel, ADMIN_SENDER, payload as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(customerMock.list).not.toHaveBeenCalled();
    expect(customerMock.count).not.toHaveBeenCalled();
    expect(customerMock.upsert).not.toHaveBeenCalled();
    expect(customerMock.detail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// customers:list — Admin and Cashier paths
// ---------------------------------------------------------------------------

describe('customers:list handler', () => {
  it('Admin can call it and receives the list response envelope', async () => {
    const rows = [makeCustomerDTO({ id: 'c-1' }), makeCustomerDTO({ id: 'c-2' })];
    customerMock.list.mockResolvedValue(Ok({ rows, nextCursor: null }));
    bindAdmin();

    const result = await invokeHandlerForTest('customers:list', ADMIN_SENDER, { pageSize: 50 });

    expect(customerMock.list).toHaveBeenCalledTimes(1);
    expect(customerMock.list).toHaveBeenCalledWith({ pageSize: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toEqual(rows);
      expect(result.value.nextCursor).toBeNull();
    }
  });

  it('Cashier can also call it (Req 7.2 — POS customer attach)', async () => {
    customerMock.list.mockResolvedValue(Ok({ rows: [], nextCursor: null }));
    bindCashier();

    const result = await invokeHandlerForTest('customers:list', CASHIER_SENDER, {});
    expect(result.ok).toBe(true);
    expect(customerMock.list).toHaveBeenCalledTimes(1);
    // No rbac.deny audit row should be written.
    const denyRow = recorder.rows.find((r) => r.actionType === 'rbac.deny');
    expect(denyRow).toBeUndefined();
  });

  it('forwards the request envelope (filter, search, sort, cursor, pageSize, withCount) untouched', async () => {
    customerMock.list.mockResolvedValue(Ok({ rows: [], nextCursor: null }));
    bindAdmin();

    const req = {
      filter: { phonePrefix: '555' },
      search: '555',
      sort: { key: 'name' as const, dir: 'asc' as const },
      cursor: 'opaque-cursor-token',
      pageSize: 100,
      withCount: true,
    };
    await invokeHandlerForTest('customers:list', ADMIN_SENDER, req);
    expect(customerMock.list).toHaveBeenCalledWith(req);
  });
});

// ---------------------------------------------------------------------------
// customers:count
// ---------------------------------------------------------------------------

describe('customers:count handler', () => {
  it('Admin receives the totalCount envelope', async () => {
    customerMock.count.mockResolvedValue(Ok({ totalCount: 42 }));
    bindAdmin();

    const result = await invokeHandlerForTest('customers:count', ADMIN_SENDER, {});
    expect(customerMock.count).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ totalCount: 42 });
    }
  });

  it('Cashier can also call it', async () => {
    customerMock.count.mockResolvedValue(Ok({ totalCount: 7 }));
    bindCashier();

    const result = await invokeHandlerForTest('customers:count', CASHIER_SENDER, {});
    expect(result.ok).toBe(true);
    expect(customerMock.count).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// customers:upsert
// ---------------------------------------------------------------------------

describe('customers:upsert handler', () => {
  it('Admin can call it and receives the upserted DTO', async () => {
    const dto = makeCustomerDTO({ id: 'c-new' });
    customerMock.upsert.mockResolvedValue(Ok(dto));
    bindAdmin();

    const result = await invokeHandlerForTest('customers:upsert', ADMIN_SENDER, sampleInput);

    expect(customerMock.upsert).toHaveBeenCalledWith(sampleInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(dto);
    }
  });

  it('Cashier can also call it (Req 7.2 — POS walk-in customer creation)', async () => {
    const dto = makeCustomerDTO({ id: 'c-walkin' });
    customerMock.upsert.mockResolvedValue(Ok(dto));
    bindCashier();

    const result = await invokeHandlerForTest('customers:upsert', CASHIER_SENDER, sampleInput);

    expect(result.ok).toBe(true);
    expect(customerMock.upsert).toHaveBeenCalledTimes(1);
    // No rbac.deny audit row should be written for cashier upsert.
    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'customers:upsert',
    );
    expect(denyRow).toBeUndefined();
  });

  it('forwards VALIDATION envelopes from the service unchanged', async () => {
    customerMock.upsert.mockResolvedValue(Err('VALIDATION', { field: 'name' }));
    bindAdmin();

    const result = await invokeHandlerForTest('customers:upsert', ADMIN_SENDER, sampleInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'name' });
    }
  });

  it('forwards FK_VIOLATION envelopes (unknown id on update) unchanged', async () => {
    customerMock.upsert.mockResolvedValue(Err('FK_VIOLATION', { reason: 'not_found' }));
    bindAdmin();

    const result = await invokeHandlerForTest('customers:upsert', ADMIN_SENDER, {
      ...sampleInput,
      id: 'gone',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });
});

// ---------------------------------------------------------------------------
// customers:detail
// ---------------------------------------------------------------------------

describe('customers:detail handler', () => {
  it('Admin can call it and receives the customer + history envelope', async () => {
    const customer = makeCustomerDTO({ id: 'c-1' });
    const history = { rows: [], nextCursor: null };
    customerMock.detail.mockResolvedValue(Ok({ customer, history }));
    bindAdmin();

    const result = await invokeHandlerForTest('customers:detail', ADMIN_SENDER, {
      id: 'c-1',
    });
    expect(customerMock.detail).toHaveBeenCalledWith({ id: 'c-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customer).toEqual(customer);
      expect(result.value.history).toEqual(history);
    }
  });

  it('Cashier can also call it (Req 7.3 — view prior purchases)', async () => {
    customerMock.detail.mockResolvedValue(
      Ok({ customer: makeCustomerDTO(), history: { rows: [], nextCursor: null } }),
    );
    bindCashier();

    const result = await invokeHandlerForTest('customers:detail', CASHIER_SENDER, {
      id: 'c-1',
    });
    expect(result.ok).toBe(true);
    expect(customerMock.detail).toHaveBeenCalledTimes(1);
  });

  it('forwards the history sub-envelope (cursor, pageSize, withCount) untouched', async () => {
    customerMock.detail.mockResolvedValue(
      Ok({ customer: makeCustomerDTO(), history: { rows: [], nextCursor: null } }),
    );
    bindAdmin();

    const req = {
      id: 'c-1',
      history: { pageSize: 20, withCount: true, cursor: 'tok' },
    };
    await invokeHandlerForTest('customers:detail', ADMIN_SENDER, req);
    expect(customerMock.detail).toHaveBeenCalledWith(req);
  });

  it('forwards FK_VIOLATION envelopes (unknown customer) unchanged', async () => {
    customerMock.detail.mockResolvedValue(Err('FK_VIOLATION', { reason: 'not_found' }));
    bindAdmin();

    const result = await invokeHandlerForTest('customers:detail', ADMIN_SENDER, {
      id: 'gone',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });
});
