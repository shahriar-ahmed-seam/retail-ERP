// src/main/ipc/handlers/pos.test.ts
//
// Unit tests for the POS IPC handler group (Phase 7, tasks 7.2 + 7.4).
//
// Drives `pos:scan` and `pos:finalize` through `invokeHandlerForTest`
// so the assertions cover the full middleware chain (auth + RBAC +
// handler).
//
// Both channels are allowed for Admin and Cashier per the static
// matrix — both roles operate the POS surface (Req 4.x, 8.3).
//
// `pos:scan` is a thin pass-through to `POSService.scan`; validation
// (empty barcode → VALIDATION) and the no-match path (Ok(null)) live
// in the service.
//
// `pos:finalize` reads the acting `userId` off `ctx.session` and
// passes it through to `POSService.finalizeSale(req, { userId })`
// so the sale's `cashierId`, each ledger movement's `userId`, and
// the journal payload all attribute the sale correctly. Mirrors the
// `purchase:create` handler-test pattern.
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 11.1,
//            12.1, 12.2.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// POSService mock
// ---------------------------------------------------------------------------

const posMock = vi.hoisted(() => ({
  scan: vi.fn(),
  finalizeSale: vi.fn(),
}));

vi.mock('@main/services/pos.service', () => ({
  POSService: posMock,
}));

vi.mock('@main/services/pos.service.js', () => ({
  POSService: posMock,
}));

// Imports MUST come after `vi.mock`.
import { sessionStore } from '@main/auth/session-store';
import { registerPosHandlers } from '@main/ipc/handlers/pos';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { FinalizeSaleInput, ProductDTO, SaleDTO } from '@shared/dto/index';

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

function bindCashier(userId = 'u-cashier'): void {
  sessionStore.bind(CASHIER_SENDER, {
    userId,
    role: 'Cashier',
    sessionId: 's-cashier',
    createdAt: new Date(),
  });
}

function makeProductDTO(overrides: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: overrides.id ?? 'p-1',
    sku: overrides.sku ?? 'SKU-1',
    name: overrides.name ?? 'Hammer',
    categoryId: overrides.categoryId ?? 'cat-1',
    ...(overrides.categoryName !== undefined ? { categoryName: overrides.categoryName } : {}),
    barcode: overrides.barcode ?? '4002',
    buyPrice: overrides.buyPrice ?? '10.00',
    sellPrice: overrides.sellPrice ?? '15.00',
    taxRate: overrides.taxRate ?? '0.18',
    warrantyMonths: overrides.warrantyMonths ?? 0,
    reorderLevel: overrides.reorderLevel ?? 5,
    onHand: overrides.onHand ?? 12,
  };
}

function makeSaleDTO(overrides: Partial<SaleDTO> = {}): SaleDTO {
  return {
    id: overrides.id ?? 'sale-1',
    serialNo: overrides.serialNo ?? 'INV-000001',
    customerId: overrides.customerId ?? null,
    customerName: overrides.customerName ?? null,
    cashierId: overrides.cashierId ?? 'u-cashier',
    cashierName: overrides.cashierName ?? 'cashier1',
    subtotal: overrides.subtotal ?? '20',
    discount: overrides.discount ?? '0',
    taxTotal: overrides.taxTotal ?? '0',
    grandTotal: overrides.grandTotal ?? '20',
    createdAt: overrides.createdAt ?? '2024-06-01T12:00:00.000Z',
    items: overrides.items ?? [],
    payments: overrides.payments ?? [],
  };
}

const sampleFinalizeInput: FinalizeSaleInput = {
  customerId: null,
  items: [
    {
      productId: 'p-1',
      quantity: 2,
      unitPrice: '10.00',
      taxRate: '0',
      lineTotal: '20.00',
    },
  ],
  discount: { kind: 'fixed', amount: '0' },
  subtotal: '20',
  discountAmount: '0',
  taxTotal: '0',
  grandTotal: '20',
  payments: [{ method: 'cash', amount: '20.00' }],
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  posMock.scan.mockReset();
  posMock.finalizeSale.mockReset();

  registerPosHandlers();
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

describe('registerPosHandlers', () => {
  it('registers pos:scan', () => {
    expect(hasHandler('pos:scan')).toBe(true);
  });

  it('registers pos:finalize (added in task 7.4)', () => {
    expect(hasHandler('pos:finalize')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerPosHandlers();
    }).not.toThrow();
    expect(hasHandler('pos:scan')).toBe(true);
    expect(hasHandler('pos:finalize')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('pos:scan requires an authenticated session', () => {
  it('returns UNAUTHENTICATED with no session', async () => {
    const result = await invokeHandlerForTest('pos:scan', ADMIN_SENDER, { barcode: '4002' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(posMock.scan).not.toHaveBeenCalled();
  });
});

describe('pos:finalize requires an authenticated session', () => {
  it('returns UNAUTHENTICATED with no session', async () => {
    const result = await invokeHandlerForTest(
      'pos:finalize',
      CASHIER_SENDER,
      sampleFinalizeInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
    expect(posMock.finalizeSale).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pos:scan — Cashier path (Req 4.1, 8.3)
// ---------------------------------------------------------------------------

describe('pos:scan handler — Cashier path', () => {
  it('Cashier can call it and receives the matching ProductDTO', async () => {
    const dto = makeProductDTO({ id: 'p-bar', barcode: '4002' });
    posMock.scan.mockResolvedValue(Ok(dto));
    bindCashier();

    const result = await invokeHandlerForTest('pos:scan', CASHIER_SENDER, { barcode: '4002' });

    expect(posMock.scan).toHaveBeenCalledTimes(1);
    expect(posMock.scan).toHaveBeenCalledWith('4002');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(dto);
    }
  });

  it('Cashier no-match scan returns Ok(null) (NOT an Err envelope)', async () => {
    posMock.scan.mockResolvedValue(Ok(null));
    bindCashier();

    const result = await invokeHandlerForTest('pos:scan', CASHIER_SENDER, { barcode: '0000' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it('does NOT write an rbac.deny audit row for the Cashier role', async () => {
    posMock.scan.mockResolvedValue(Ok(null));
    bindCashier();

    await invokeHandlerForTest('pos:scan', CASHIER_SENDER, { barcode: '4002' });

    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pos:scan — Admin path
// ---------------------------------------------------------------------------

describe('pos:scan handler — Admin path', () => {
  it('Admin can call it and receives the matching ProductDTO', async () => {
    const dto = makeProductDTO({ id: 'p-admin', barcode: '7777' });
    posMock.scan.mockResolvedValue(Ok(dto));
    bindAdmin();

    const result = await invokeHandlerForTest('pos:scan', ADMIN_SENDER, { barcode: '7777' });

    expect(posMock.scan).toHaveBeenCalledTimes(1);
    expect(posMock.scan).toHaveBeenCalledWith('7777');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(dto);
    }
  });

  it('Admin no-match scan returns Ok(null)', async () => {
    posMock.scan.mockResolvedValue(Ok(null));
    bindAdmin();

    const result = await invokeHandlerForTest('pos:scan', ADMIN_SENDER, { barcode: 'no-such' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Forwarding semantics
// ---------------------------------------------------------------------------

describe('pos:scan handler — forwarding semantics', () => {
  it('forwards an empty barcode as-is to the service (which returns VALIDATION)', async () => {
    posMock.scan.mockResolvedValue(Err('VALIDATION', { field: 'barcode' }));
    bindCashier();

    const result = await invokeHandlerForTest('pos:scan', CASHIER_SENDER, { barcode: '' });

    expect(posMock.scan).toHaveBeenCalledWith('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'barcode' });
    }
  });

  it('forwards a whitespace-only barcode as-is (service decides)', async () => {
    posMock.scan.mockResolvedValue(Err('VALIDATION', { field: 'barcode' }));
    bindAdmin();

    const result = await invokeHandlerForTest('pos:scan', ADMIN_SENDER, { barcode: '   ' });

    expect(posMock.scan).toHaveBeenCalledWith('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  it('converts a thrown service error into INTERNAL via the router', async () => {
    posMock.scan.mockRejectedValue(new Error('db unavailable'));
    bindAdmin();

    const result = await invokeHandlerForTest('pos:scan', ADMIN_SENDER, { barcode: '4002' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
    }
  });
});

// ---------------------------------------------------------------------------
// pos:finalize — Cashier path (Req 4.x, 8.3)
// ---------------------------------------------------------------------------

describe('pos:finalize handler — Cashier path', () => {
  it('Cashier can call it; the service receives userId: u-cashier from the session', async () => {
    const sale = makeSaleDTO({ id: 'sale-1', cashierId: 'u-cashier' });
    posMock.finalizeSale.mockResolvedValue(
      Ok({ saleId: 'sale-1', serialNo: 'INV-000001', sale }),
    );
    bindCashier('u-cashier');

    const result = await invokeHandlerForTest(
      'pos:finalize',
      CASHIER_SENDER,
      sampleFinalizeInput,
    );

    expect(posMock.finalizeSale).toHaveBeenCalledTimes(1);
    expect(posMock.finalizeSale).toHaveBeenCalledWith(sampleFinalizeInput, {
      userId: 'u-cashier',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.saleId).toBe('sale-1');
      expect(result.value.serialNo).toBe('INV-000001');
      expect(result.value.sale).toEqual(sale);
    }
  });

  it('forwards the acting userId from the session into the service ctx (alternate cashier id)', async () => {
    const sale = makeSaleDTO({ cashierId: 'u-other' });
    posMock.finalizeSale.mockResolvedValue(
      Ok({ saleId: 'sale-2', serialNo: 'INV-000002', sale }),
    );
    bindCashier('u-other');

    await invokeHandlerForTest('pos:finalize', CASHIER_SENDER, sampleFinalizeInput);

    expect(posMock.finalizeSale).toHaveBeenCalledWith(sampleFinalizeInput, {
      userId: 'u-other',
    });
  });

  it('does NOT write an rbac.deny audit row for the Cashier role', async () => {
    posMock.finalizeSale.mockResolvedValue(
      Ok({ saleId: 'sale-1', serialNo: 'INV-000001', sale: makeSaleDTO() }),
    );
    bindCashier();

    await invokeHandlerForTest('pos:finalize', CASHIER_SENDER, sampleFinalizeInput);

    expect(recorder.rows.find((r) => r.actionType === 'rbac.deny')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pos:finalize — Admin path
// ---------------------------------------------------------------------------

describe('pos:finalize handler — Admin path', () => {
  it('Admin can call it; the service receives userId: u-admin from the session', async () => {
    const sale = makeSaleDTO({ cashierId: 'u-admin', cashierName: 'admin1' });
    posMock.finalizeSale.mockResolvedValue(
      Ok({ saleId: 'sale-3', serialNo: 'INV-000003', sale }),
    );
    bindAdmin('u-admin');

    const result = await invokeHandlerForTest(
      'pos:finalize',
      ADMIN_SENDER,
      sampleFinalizeInput,
    );

    expect(posMock.finalizeSale).toHaveBeenCalledTimes(1);
    expect(posMock.finalizeSale).toHaveBeenCalledWith(sampleFinalizeInput, {
      userId: 'u-admin',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.saleId).toBe('sale-3');
    }
  });
});

// ---------------------------------------------------------------------------
// pos:finalize — error envelope forwarding
// ---------------------------------------------------------------------------

describe('pos:finalize handler — forwarding semantics', () => {
  it('forwards VALIDATION envelopes (totals mismatch) unchanged', async () => {
    posMock.finalizeSale.mockResolvedValue(
      Err('VALIDATION', { field: 'grandTotal', expected: '20', actual: '99' }),
    );
    bindCashier();

    const result = await invokeHandlerForTest('pos:finalize', CASHIER_SENDER, {
      ...sampleFinalizeInput,
      grandTotal: '99',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({
        field: 'grandTotal',
        expected: '20',
        actual: '99',
      });
    }
  });

  it('forwards OUT_OF_STOCK envelopes unchanged', async () => {
    posMock.finalizeSale.mockResolvedValue(
      Err('OUT_OF_STOCK', { productId: 'p-1' }),
    );
    bindCashier();

    const result = await invokeHandlerForTest(
      'pos:finalize',
      CASHIER_SENDER,
      sampleFinalizeInput,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('OUT_OF_STOCK');
      expect(result.error.details).toEqual({ productId: 'p-1' });
    }
  });

  it('forwards FK_VIOLATION envelopes unchanged', async () => {
    posMock.finalizeSale.mockResolvedValue(
      Err('FK_VIOLATION', { reason: 'not_found' }),
    );
    bindCashier();

    const result = await invokeHandlerForTest('pos:finalize', CASHIER_SENDER, {
      ...sampleFinalizeInput,
      customerId: 'c-missing',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });

  it('converts a thrown service error into INTERNAL via the router', async () => {
    posMock.finalizeSale.mockRejectedValue(new Error('db unavailable'));
    bindCashier();

    const result = await invokeHandlerForTest(
      'pos:finalize',
      CASHIER_SENDER,
      sampleFinalizeInput,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
    }
  });
});
