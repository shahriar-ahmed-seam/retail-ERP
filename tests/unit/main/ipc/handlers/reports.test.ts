import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the reports IPC handler group (Phase 5 task 5.3 +
 * Phase 10 tasks 10.1–10.4).
 *
 * Drives the four read-side report channels through
 * `invokeHandlerForTest` — the same code path Electron's
 * `ipcMain.handle` uses in production — so the assertions cover the
 * full middleware chain (auth + RBAC + handler), not just the handler
 * body.
 *
 * RBAC matrix surface:
 *   - `reports:dailySales`   ADMIN_ONLY  (Req 9.1, 8.2)
 *   - `reports:monthlySales` ADMIN_ONLY  (Req 9.2, 8.2)
 *   - `reports:lowStock`     ALL_ROLES   (Req 3.6, 9.3)
 *   - `reports:topSelling`   ADMIN_ONLY  (Req 9.4, 8.2)
 *
 * The tests assert:
 *   - admin sessions can call every channel,
 *   - cashier sessions are denied on the three Admin-only channels
 *     with `Err('FORBIDDEN')` AND an `rbac.deny` audit row written,
 *   - cashier sessions can call `reports:lowStock` (the banner the
 *     channel backs is visible to cashiers too),
 *   - missing sessions return `Err('UNAUTHENTICATED')` before the
 *     service is touched.
 *
 * Both `@main/services/report.service` and
 * `@main/services/inventory.service` are mocked so the handler
 * surface is deterministic; the unit-level coverage of the actual
 * SQL projections lives in
 * `tests/unit/main/services/report.service.test.ts` and
 * `tests/unit/main/services/inventory.service.test.ts`.
 *
 * Validates: Requirements 3.6, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4.
 */

// ---------------------------------------------------------------------------
// Service mocks
// ---------------------------------------------------------------------------

const reportMock = vi.hoisted(() => ({
  dailySales: vi.fn(),
  monthlySales: vi.fn(),
  lowStockSummary: vi.fn(),
  topSelling: vi.fn(),
}));

vi.mock('@main/services/report.service', () => ({
  ReportService: reportMock,
}));

vi.mock('@main/services/report.service.js', () => ({
  ReportService: reportMock,
}));

const exportMock = vi.hoisted(() => ({
  exportReport: vi.fn(),
}));

vi.mock('@main/services/report/index', async (importActual) => {
  const actual = await importActual<typeof import('@main/services/report/index')>();
  return { ...actual, exportReport: exportMock.exportReport };
});

vi.mock('@main/services/report/index.js', async (importActual) => {
  const actual =
    await importActual<typeof import('@main/services/report/index.js')>();
  return { ...actual, exportReport: exportMock.exportReport };
});

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
import {
  registerReportsHandlers,
  resetSaveDialogOpener,
  setSaveDialogOpener,
} from '@main/ipc/handlers/reports';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type {
  DailySalesReport,
  LowStockRow,
  MonthlySalesReport,
  TopSellingRow,
} from '@shared/ipc-contract';

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

const sampleLowStockRows: readonly LowStockRow[] = Object.freeze([
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

const sampleDailySales: DailySalesReport = Object.freeze({
  date: '2024-05-15',
  salesCount: 3,
  totalRevenue: '300',
  totalTax: '54',
  totalDiscount: '15',
  paymentBreakdown: Object.freeze([
    Object.freeze({ method: 'cash' as const, amount: '100' }),
    Object.freeze({ method: 'card' as const, amount: '200' }),
  ]),
});

const sampleMonthlySales: MonthlySalesReport = Object.freeze({
  month: '2024-05',
  salesCount: 42,
  totalRevenue: '4200',
  totalTax: '756',
  totalDiscount: '210',
});

const sampleTopRows: readonly TopSellingRow[] = Object.freeze([
  Object.freeze({
    productId: 'p-1',
    sku: 'A',
    name: 'Alpha',
    unitsSold: 50,
    revenue: '500',
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

  reportMock.dailySales.mockReset();
  reportMock.monthlySales.mockReset();
  reportMock.lowStockSummary.mockReset();
  reportMock.topSelling.mockReset();
  exportMock.exportReport.mockReset();
  inventoryMock.applyMovement.mockReset();
  inventoryMock.adjust.mockReset();
  inventoryMock.lowStockCount.mockReset();
  inventoryMock.lowStockList.mockReset();

  registerReportsHandlers();
});

afterEach(() => {
  resetAuditWriter();
  resetSaveDialogOpener();
  clearHandlers();
  sessionStore.clearAll();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

describe('registerReportsHandlers', () => {
  it('registers all five report channels', () => {
    expect(hasHandler('reports:dailySales')).toBe(true);
    expect(hasHandler('reports:monthlySales')).toBe(true);
    expect(hasHandler('reports:lowStock')).toBe(true);
    expect(hasHandler('reports:topSelling')).toBe(true);
    expect(hasHandler('reports:export')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerReportsHandlers();
    }).not.toThrow();
    expect(hasHandler('reports:dailySales')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth gate (default `requiresAuth: true`)
// ---------------------------------------------------------------------------

describe('reports:* require an authenticated session', () => {
  it.each([
    ['reports:dailySales' as const, { date: '2024-05-15' }],
    ['reports:monthlySales' as const, { month: '2024-05' }],
    ['reports:lowStock' as const, undefined],
    ['reports:topSelling' as const, { dateFrom: '2024-05-01', dateTo: '2024-05-31' }],
    ['reports:export' as const, { reportId: 'lowStock' as const, format: 'csv' as const }],
  ])('%s returns UNAUTHENTICATED with no session bound', async (channel, payload) => {
    const result = await invokeHandlerForTest(channel, ADMIN_SENDER, payload as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNAUTHENTICATED');
    expect(reportMock.dailySales).not.toHaveBeenCalled();
    expect(reportMock.monthlySales).not.toHaveBeenCalled();
    expect(reportMock.lowStockSummary).not.toHaveBeenCalled();
    expect(reportMock.topSelling).not.toHaveBeenCalled();
    expect(exportMock.exportReport).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reports:dailySales
// ---------------------------------------------------------------------------

describe('reports:dailySales handler', () => {
  it('Admin can call it and receives the report envelope', async () => {
    reportMock.dailySales.mockResolvedValue(Ok(sampleDailySales));
    bindAdmin();

    const result = await invokeHandlerForTest('reports:dailySales', ADMIN_SENDER, {
      date: '2024-05-15',
    });
    expect(reportMock.dailySales).toHaveBeenCalledWith({ date: '2024-05-15' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(sampleDailySales);
  });

  it('forwards VALIDATION envelopes from the service unchanged', async () => {
    reportMock.dailySales.mockResolvedValue(Err('VALIDATION', { field: 'date' }));
    bindAdmin();

    const result = await invokeHandlerForTest('reports:dailySales', ADMIN_SENDER, {
      date: 'bad',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'date' });
    }
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    reportMock.dailySales.mockResolvedValue(Ok(sampleDailySales));
    bindCashier();

    const result = await invokeHandlerForTest('reports:dailySales', CASHIER_SENDER, {
      date: '2024-05-15',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    expect(reportMock.dailySales).not.toHaveBeenCalled();

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'reports:dailySales',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });
});

// ---------------------------------------------------------------------------
// reports:monthlySales
// ---------------------------------------------------------------------------

describe('reports:monthlySales handler', () => {
  it('Admin can call it and receives the report envelope', async () => {
    reportMock.monthlySales.mockResolvedValue(Ok(sampleMonthlySales));
    bindAdmin();

    const result = await invokeHandlerForTest('reports:monthlySales', ADMIN_SENDER, {
      month: '2024-05',
    });
    expect(reportMock.monthlySales).toHaveBeenCalledWith({ month: '2024-05' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(sampleMonthlySales);
  });

  it('Cashier is denied with FORBIDDEN', async () => {
    reportMock.monthlySales.mockResolvedValue(Ok(sampleMonthlySales));
    bindCashier();

    const result = await invokeHandlerForTest('reports:monthlySales', CASHIER_SENDER, {
      month: '2024-05',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    expect(reportMock.monthlySales).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reports:lowStock — Admin + Cashier (banner-backing channel)
// ---------------------------------------------------------------------------

describe('reports:lowStock handler', () => {
  it('Admin can call it and receives the { rows } envelope', async () => {
    reportMock.lowStockSummary.mockResolvedValue(Ok({ rows: sampleLowStockRows }));
    bindAdmin();

    const result = await invokeHandlerForTest('reports:lowStock', ADMIN_SENDER, undefined);
    expect(reportMock.lowStockSummary).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rows).toEqual(sampleLowStockRows);
  });

  it('Cashier can also call it because the banner is visible to all roles', async () => {
    reportMock.lowStockSummary.mockResolvedValue(Ok({ rows: sampleLowStockRows }));
    bindCashier();

    const result = await invokeHandlerForTest('reports:lowStock', CASHIER_SENDER, undefined);
    expect(result.ok).toBe(true);
    expect(reportMock.lowStockSummary).toHaveBeenCalledTimes(1);
    const denyRow = recorder.rows.find((r) => r.actionType === 'rbac.deny');
    expect(denyRow).toBeUndefined();
  });

  it('forwards an empty row list unchanged', async () => {
    reportMock.lowStockSummary.mockResolvedValue(Ok({ rows: [] }));
    bindAdmin();

    const result = await invokeHandlerForTest('reports:lowStock', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reports:topSelling
// ---------------------------------------------------------------------------

describe('reports:topSelling handler', () => {
  it('Admin can call it and receives the { rows } envelope', async () => {
    reportMock.topSelling.mockResolvedValue(Ok({ rows: sampleTopRows }));
    bindAdmin();

    const req = { dateFrom: '2024-05-01', dateTo: '2024-05-31', limit: 10 };
    const result = await invokeHandlerForTest('reports:topSelling', ADMIN_SENDER, req);
    expect(reportMock.topSelling).toHaveBeenCalledWith(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rows).toEqual(sampleTopRows);
  });

  it('forwards the limit field untouched', async () => {
    reportMock.topSelling.mockResolvedValue(Ok({ rows: [] }));
    bindAdmin();

    await invokeHandlerForTest('reports:topSelling', ADMIN_SENDER, {
      dateFrom: '2024-05-01',
      dateTo: '2024-05-31',
    });
    expect(reportMock.topSelling).toHaveBeenCalledWith({
      dateFrom: '2024-05-01',
      dateTo: '2024-05-31',
    });
  });

  it('Cashier is denied with FORBIDDEN', async () => {
    reportMock.topSelling.mockResolvedValue(Ok({ rows: sampleTopRows }));
    bindCashier();

    const result = await invokeHandlerForTest('reports:topSelling', CASHIER_SENDER, {
      dateFrom: '2024-05-01',
      dateTo: '2024-05-31',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    expect(reportMock.topSelling).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reports:export — combined exporter
// ---------------------------------------------------------------------------

describe('reports:export handler', () => {
  it('Admin can call it; bypasses dialog when paths are pre-supplied', async () => {
    const dialog = vi.fn();
    setSaveDialogOpener(dialog);
    exportMock.exportReport.mockResolvedValue(
      Ok({ path: '/tmp/x.csv', rowCount: 12 }),
    );
    bindAdmin();

    const result = await invokeHandlerForTest('reports:export', ADMIN_SENDER, {
      reportId: 'lowStock',
      format: 'csv',
      paths: { csv: '/tmp/x.csv' },
    });

    expect(dialog).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ path: '/tmp/x.csv', rowCount: 12 });
    }
    expect(exportMock.exportReport).toHaveBeenCalledTimes(1);
  });

  it('Cashier is denied with FORBIDDEN', async () => {
    setSaveDialogOpener(vi.fn());
    bindCashier();

    const result = await invokeHandlerForTest('reports:export', CASHIER_SENDER, {
      reportId: 'lowStock',
      format: 'csv',
      paths: { csv: '/tmp/x.csv' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    expect(exportMock.exportReport).not.toHaveBeenCalled();
  });

  it('opens the save dialog when paths are missing and forwards the chosen path', async () => {
    const dialog = vi.fn().mockResolvedValue('/picked/dailySales.csv');
    setSaveDialogOpener(dialog);
    exportMock.exportReport.mockResolvedValue(
      Ok({ path: '/picked/dailySales.csv', rowCount: 5 }),
    );
    bindAdmin();

    const result = await invokeHandlerForTest('reports:export', ADMIN_SENDER, {
      reportId: 'dailySales',
      format: 'csv',
      filter: { date: '2024-05-15' },
    });

    expect(dialog).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toBe('/picked/dailySales.csv');
    }
    expect(exportMock.exportReport).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: { csv: '/picked/dailySales.csv' },
      }),
    );
  });

  it('returns USER_CANCELED when the dialog is dismissed', async () => {
    const dialog = vi.fn().mockResolvedValue(null);
    setSaveDialogOpener(dialog);
    bindAdmin();

    const result = await invokeHandlerForTest('reports:export', ADMIN_SENDER, {
      reportId: 'lowStock',
      format: 'csv',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('USER_CANCELED');
      expect(result.error.details).toMatchObject({ format: 'csv' });
    }
    expect(exportMock.exportReport).not.toHaveBeenCalled();
  });

  it('opens one dialog per requested format when both formats are requested', async () => {
    const dialog = vi
      .fn()
      .mockResolvedValueOnce('/picked/x.csv')
      .mockResolvedValueOnce('/picked/x.pdf');
    setSaveDialogOpener(dialog);
    exportMock.exportReport.mockResolvedValue(
      Ok({ csvPath: '/picked/x.csv', pdfPath: '/picked/x.pdf', rowCount: 3 }),
    );
    bindAdmin();

    const result = await invokeHandlerForTest('reports:export', ADMIN_SENDER, {
      reportId: 'lowStock',
      format: ['csv', 'pdf'],
    });

    expect(dialog).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        csvPath: '/picked/x.csv',
        pdfPath: '/picked/x.pdf',
        rowCount: 3,
      });
    }
    expect(exportMock.exportReport).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: { csv: '/picked/x.csv', pdf: '/picked/x.pdf' },
      }),
    );
  });

  it('returns VALIDATION when format is missing or unrecognized', async () => {
    setSaveDialogOpener(vi.fn());
    bindAdmin();

    const result = await invokeHandlerForTest('reports:export', ADMIN_SENDER, {
      reportId: 'lowStock',
      format: [] as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'format' });
    }
  });
});
