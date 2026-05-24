import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the settings + printer:test IPC handler group
 * (Phase 8, task 8.6).
 *
 * Drives every channel through `invokeHandlerForTest` — the same
 * code path Electron's `ipcMain.handle` uses in production — so the
 * assertions cover the full middleware chain (auth + RBAC + handler).
 *
 * Coverage:
 *
 *   - `settings:get`  Admin path returns the JSON-decoded value.
 *                     Cashier is allowed (matrix grants ALL_ROLES).
 *                     Missing row surfaces `Ok({ value: null })`.
 *                     Malformed JSON surfaces `Err('DB_INTEGRITY')`.
 *
 *   - `settings:set`  Admin path persists the JSON-encoded value.
 *                     Cashier is denied with `FORBIDDEN` and an
 *                     `rbac.deny` audit row is written.
 *                     Validation: empty key surfaces VALIDATION.
 *
 *   - `printer:test`  Admin path runs the chain with a synthetic
 *                     `ReceiptDTO` that carries the configured shop
 *                     info, `'INV-TEST'`, a single 'TEST PRINT'
 *                     line, zero totals, and no payments.
 *                     `Ok({ adapter })` is forwarded unchanged on
 *                     chain success; chain failure forwards the
 *                     LAST adapter's `Err` envelope.
 *                     Cashier is denied with `FORBIDDEN` and an
 *                     `rbac.deny` audit row is written (Req 8.4).
 *                     UNAUTHENTICATED surface is verified.
 *
 * Validates: Requirements 4.7, 8.2, 8.3, 8.4.
 */

import { sessionStore } from '@main/auth/session-store';
import {
  __testables,
  registerSettingsHandlers,
  resetSettingsHandlerDeps,
  setSettingsHandlerDeps,
  type SettingsHandlerDeps,
  type SettingsPrismaLike,
} from '@main/ipc/handlers/settings';
import {
  clearHandlers,
  hasHandler,
  invokeHandlerForTest,
  resetAuditWriter,
  setAuditWriter,
} from '@main/ipc/router';
import { Err, Ok } from '@shared/result';

import type { AuditWriteInput, AuditWriter } from '@main/ipc/router';
import type { ChainAdapter, ReceiptRendererPrismaLike } from '@main/printing/index';
import type { ReceiptDTO, ReceiptShopInfo } from '@shared/dto/index';

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

// ---------------------------------------------------------------------------
// Stub Prisma + chain
// ---------------------------------------------------------------------------

interface StubRow {
  key: string;
  value: string;
}

function makePrismaStub(initial: readonly StubRow[]): SettingsPrismaLike &
  ReceiptRendererPrismaLike {
  const store = new Map<string, string>();
  for (const row of initial) {
    store.set(row.key, row.value);
  }
  return {
    setting: {
      findUnique: ({ where }) => {
        const value = store.get(where.key);
        return Promise.resolve(value === undefined ? null : { value });
      },
      upsert: ({ where, update, create }) => {
        if (store.has(where.key)) {
          store.set(where.key, update.value);
          return Promise.resolve({ key: where.key, value: update.value });
        }
        store.set(create.key, create.value);
        return Promise.resolve({ key: create.key, value: create.value });
      },
      findMany: ({ where }) => {
        const wantedKeys = where.key.in;
        const result: { key: string; value: string }[] = [];
        for (const k of wantedKeys) {
          const v = store.get(k);
          if (v !== undefined) result.push({ key: k, value: v });
        }
        return Promise.resolve(result);
      },
    },
  };
}

const STUB_SHOP_INFO: ReceiptShopInfo = {
  name: 'Stub Shop',
  address: null,
  phone: null,
  taxId: null,
};

interface ChainRecorder {
  readonly chain: ChainAdapter;
  readonly print: ReturnType<typeof vi.fn>;
}

function makeChainRecorder(
  result:
    | { ok: true; value: { adapter: 'escpos' | 'html' | 'pdf'; output?: string } }
    | { ok: false; error: ReturnType<typeof Err>['error'] },
): ChainRecorder {
  const print = vi.fn(() => Promise.resolve(result));
  const chain: ChainAdapter = {
    adapters: [],
    print,
  };
  return { chain, print };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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

let recorder: RecordingAuditWriter;
let chainRecorder: ChainRecorder;
let loadShopInfoStub: ReturnType<typeof vi.fn>;
let prismaStub: SettingsPrismaLike & ReceiptRendererPrismaLike;
const NOW = new Date('2024-06-15T10:00:00.000Z');

function installDeps(overrides: Partial<SettingsHandlerDeps> = {}): SettingsHandlerDeps {
  const deps: SettingsHandlerDeps = {
    prisma: overrides.prisma ?? prismaStub,
    selectPrinter: overrides.selectPrinter ?? (() => chainRecorder.chain),
    loadShopInfo: overrides.loadShopInfo ?? loadShopInfoStub,
    now: overrides.now ?? (() => NOW),
  };
  setSettingsHandlerDeps(deps);
  return deps;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {
    /* silence the router's defensive logs */
  });

  clearHandlers();
  sessionStore.clearAll();
  recorder = new RecordingAuditWriter();
  setAuditWriter(recorder);

  prismaStub = makePrismaStub([]);
  chainRecorder = makeChainRecorder(Ok({ adapter: 'escpos' }));
  loadShopInfoStub = vi.fn(() => Promise.resolve(STUB_SHOP_INFO));
  installDeps();

  registerSettingsHandlers();
});

afterEach(() => {
  resetAuditWriter();
  resetSettingsHandlerDeps();
  clearHandlers();
  sessionStore.clearAll();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Channel registration
// ---------------------------------------------------------------------------

describe('registerSettingsHandlers', () => {
  it('registers all three channels', () => {
    expect(hasHandler('settings:get')).toBe(true);
    expect(hasHandler('settings:set')).toBe(true);
    expect(hasHandler('printer:test')).toBe(true);
  });

  it('is idempotent — re-running replaces, does not error', () => {
    expect(() => {
      registerSettingsHandlers();
    }).not.toThrow();
    expect(hasHandler('settings:get')).toBe(true);
    expect(hasHandler('settings:set')).toBe(true);
    expect(hasHandler('printer:test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// settings:get
// ---------------------------------------------------------------------------

describe('settings:get handler', () => {
  it('returns UNAUTHENTICATED with no session bound', async () => {
    const result = await invokeHandlerForTest('settings:get', ADMIN_SENDER, {
      key: 'printer.escpos',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNAUTHENTICATED');
  });

  it('Admin can read a stored value (JSON-decoded)', async () => {
    prismaStub = makePrismaStub([
      { key: 'printer.escpos', value: JSON.stringify({ kind: 'usb', target: '04b8:0202' }) },
    ]);
    installDeps();
    bindAdmin();

    const result = await invokeHandlerForTest('settings:get', ADMIN_SENDER, {
      key: 'printer.escpos',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        value: { kind: 'usb', target: '04b8:0202' },
      });
    }
  });

  it('Cashier can also read (matrix allows ALL_ROLES)', async () => {
    prismaStub = makePrismaStub([{ key: 'shop.name', value: '"Acme"' }]);
    installDeps();
    bindCashier();

    const result = await invokeHandlerForTest('settings:get', CASHIER_SENDER, {
      key: 'shop.name',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ value: 'Acme' });
  });

  it('returns Ok({ value: null }) when the row is missing', async () => {
    bindAdmin();
    const result = await invokeHandlerForTest('settings:get', ADMIN_SENDER, {
      key: 'shop.name',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ value: null });
  });

  it('returns DB_INTEGRITY when the stored value is malformed JSON', async () => {
    prismaStub = makePrismaStub([{ key: 'shop.name', value: '{not json' }]);
    installDeps();
    bindAdmin();

    const result = await invokeHandlerForTest('settings:get', ADMIN_SENDER, {
      key: 'shop.name',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DB_INTEGRITY');
      expect(result.error.details).toMatchObject({
        reason: 'malformed_setting_json',
        key: 'shop.name',
      });
    }
  });

  it('returns VALIDATION on an empty key', async () => {
    bindAdmin();
    const result = await invokeHandlerForTest('settings:get', ADMIN_SENDER, { key: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'key' });
    }
  });
});

// ---------------------------------------------------------------------------
// settings:set
// ---------------------------------------------------------------------------

describe('settings:set handler', () => {
  it('Admin can persist a JSON-encoded value', async () => {
    bindAdmin();
    const result = await invokeHandlerForTest('settings:set', ADMIN_SENDER, {
      key: 'printer.escpos',
      value: { kind: 'network', target: '192.168.1.50:9100' },
    });

    expect(result.ok).toBe(true);

    // Confirm round-trip: a follow-up settings:get reads the stored value.
    const readback = await invokeHandlerForTest('settings:get', ADMIN_SENDER, {
      key: 'printer.escpos',
    });
    expect(readback.ok).toBe(true);
    if (readback.ok) {
      expect(readback.value).toEqual({
        value: { kind: 'network', target: '192.168.1.50:9100' },
      });
    }
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('settings:set', CASHIER_SENDER, {
      key: 'printer.escpos',
      value: { kind: 'usb', target: '' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'settings:set' });
    }

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'settings:set',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });

  it('returns VALIDATION on an empty key', async () => {
    bindAdmin();
    const result = await invokeHandlerForTest('settings:set', ADMIN_SENDER, {
      key: '',
      value: { kind: 'usb', target: '' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'key' });
    }
  });

  it('returns VALIDATION when the value is not JSON-serializable (undefined)', async () => {
    bindAdmin();
    // Pass `undefined` — the wire type is `unknown` so this is reachable.
    const result = await invokeHandlerForTest('settings:set', ADMIN_SENDER, {
      key: 'printer.escpos',
      value: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// printer:test
// ---------------------------------------------------------------------------

describe('printer:test handler', () => {
  it('returns UNAUTHENTICATED with no session bound', async () => {
    const result = await invokeHandlerForTest('printer:test', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNAUTHENTICATED');
    expect(chainRecorder.print).not.toHaveBeenCalled();
  });

  it('Cashier is denied with FORBIDDEN and an rbac.deny audit row is written', async () => {
    bindCashier();

    const result = await invokeHandlerForTest('printer:test', CASHIER_SENDER, undefined);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.details).toEqual({ channel: 'printer:test' });
    }
    expect(chainRecorder.print).not.toHaveBeenCalled();

    const denyRow = recorder.rows.find(
      (r) => r.actionType === 'rbac.deny' && r.entityId === 'printer:test',
    );
    expect(denyRow).toBeDefined();
    expect(denyRow?.userId).toBe('u-cashier');
  });

  it('Admin runs the chain and the synthetic receipt has the expected shape', async () => {
    bindAdmin();
    chainRecorder = makeChainRecorder(Ok({ adapter: 'escpos' }));
    installDeps();

    const result = await invokeHandlerForTest('printer:test', ADMIN_SENDER, undefined);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ adapter: 'escpos' });

    expect(chainRecorder.print).toHaveBeenCalledTimes(1);
    const arg = chainRecorder.print.mock.calls[0]?.[0] as ReceiptDTO | undefined;
    expect(arg).toBeDefined();
    if (arg !== undefined) {
      expect(arg.shopInfo).toEqual(STUB_SHOP_INFO);
      expect(arg.serialNo).toBe('INV-TEST');
      expect(arg.createdAt).toBe(NOW.toISOString());
      expect(arg.lines).toHaveLength(1);
      expect(arg.lines[0]?.name).toBe('TEST PRINT');
      expect(arg.subtotal).toBe('0.00');
      expect(arg.discount).toBe('0.00');
      expect(arg.taxTotal).toBe('0.00');
      expect(arg.grandTotal).toBe('0.00');
      expect(arg.payments).toEqual([]);
    }
  });

  it('forwards the chain Err envelope unchanged on chain failure', async () => {
    bindAdmin();
    chainRecorder = makeChainRecorder(
      Err('PRINTER_FAILURE', { reason: 'io', cause: 'no printer' }),
    );
    installDeps();

    const result = await invokeHandlerForTest('printer:test', ADMIN_SENDER, undefined);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINTER_FAILURE');
      expect(result.error.details).toMatchObject({ reason: 'io' });
    }
  });

  it('forwards the PDF adapter output path on success', async () => {
    bindAdmin();
    chainRecorder = makeChainRecorder(
      Ok({ adapter: 'pdf', output: '/tmp/receipts/INV-TEST.pdf' }),
    );
    installDeps();

    const result = await invokeHandlerForTest('printer:test', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        adapter: 'pdf',
        output: '/tmp/receipts/INV-TEST.pdf',
      });
    }
  });

  it('maps a load-shop-info throw to PRINTER_FAILURE / io', async () => {
    bindAdmin();
    loadShopInfoStub = vi.fn(() => Promise.reject(new Error('db gone')));
    installDeps();

    const result = await invokeHandlerForTest('printer:test', ADMIN_SENDER, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PRINTER_FAILURE');
      expect(result.error.details).toMatchObject({ reason: 'io' });
    }
    expect(chainRecorder.print).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// __testables export — sanity check
// ---------------------------------------------------------------------------

describe('__testables', () => {
  it('exposes all three handler functions', () => {
    expect(__testables.getHandler).toBeTypeOf('function');
    expect(__testables.setHandler).toBeTypeOf('function');
    expect(__testables.testPrintHandler).toBeTypeOf('function');
  });
});
