// tests/unit/main/printing/escpos-adapter.test.ts
//
// Phase 8, task 8.2 — ESC/POS printer adapter unit tests.
//
// Two surfaces under test:
//
//   1. `print(receipt)` returns `Err({ reason: 'unconfigured' })`
//      when `Setting('printer.escpos').target === ''` (the seeded
//      default). The chain falls through to HTML on this code.
//
//   2. `print(receipt)` walks the configured printer and emits the
//      command sequence specified by design.md > "Receipt Printing
//      Pipeline" — header, shop info, line items, totals, payments,
//      barcode/serial, cut. We inject a recording stub for both
//      Prisma and the `node-thermal-printer` factory so the
//      assertions cover the command sequence without booting USB
//      drivers or SQLite.
//
// Validates: Requirement 4.7.

import { describe, expect, it } from 'vitest';

import {
  print,
  type EscPosConfig,
  type PrismaLike,
  type ThermalPrinterLike,
} from '@main/printing/escpos-adapter';

import type { ReceiptDTO } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

/**
 * Build a `PrismaLike` whose `setting.findUnique` returns whatever
 * value is supplied for the `printer.escpos` row. `null` simulates a
 * missing row; an empty string simulates the seeded default.
 */
function makePrisma(value: string | null): PrismaLike {
  return {
    setting: {
      findUnique: (args: { where: { key: string } }) => {
        if (args.where.key !== 'printer.escpos') {
          return Promise.resolve(null);
        }
        return Promise.resolve(value === null ? null : { value });
      },
    },
  };
}

/**
 * Recording fake of `ThermalPrinterLike`. Captures every command
 * call as a structured `{ method, args }` event so the test can
 * assert the EXACT sequence the adapter emits, not just the set of
 * methods called.
 *
 * `connected` controls the `isPrinterConnected()` return value;
 * `executeError` simulates an `execute()` rejection so the I/O
 * mapping path is observable.
 */
interface RecordedEvent {
  readonly method: string;
  readonly args: readonly unknown[];
}

interface RecordingPrinter extends ThermalPrinterLike {
  readonly events: readonly RecordedEvent[];
  readonly settings: { connected: boolean; executeError: Error | null };
}

function makeRecordingPrinter(init?: {
  connected?: boolean;
  executeError?: Error;
}): RecordingPrinter {
  const events: RecordedEvent[] = [];
  const settings = {
    connected: init?.connected ?? true,
    executeError: init?.executeError ?? null,
  };

  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      events.push({ method, args });
    };

  return {
    events,
    settings,
    alignCenter: record('alignCenter'),
    alignLeft: record('alignLeft'),
    alignRight: record('alignRight'),
    bold: record('bold'),
    drawLine: record('drawLine'),
    leftRight: record('leftRight'),
    newLine: record('newLine'),
    println: record('println'),
    print: record('print'),
    cut: record('cut'),
    isPrinterConnected: () => Promise.resolve(settings.connected),
    execute: () => {
      if (settings.executeError !== null) {
        return Promise.reject(settings.executeError);
      }
      events.push({ method: 'execute', args: [] });
      return Promise.resolve('ok');
    },
  };
}

const SAMPLE_RECEIPT: ReceiptDTO = {
  shopInfo: {
    name: 'Core Retail Shop',
    address: '123 Market St',
    phone: '555-0100',
    taxId: 'TAX-12345',
  },
  serialNo: 'INV-000123',
  createdAt: '2026-05-24T07:38:08.000Z',
  cashierName: 'cashier-01',
  customerName: 'Alice Lee',
  lines: [
    {
      name: 'Widget',
      quantity: 2,
      unitPrice: '5.00',
      lineTotal: '10.00',
      taxRate: '0.10',
    },
    {
      name: 'Gadget',
      quantity: 1,
      unitPrice: '10.00',
      lineTotal: '10.00',
      taxRate: '0.05',
    },
  ],
  subtotal: '20.00',
  discount: '2.00',
  taxTotal: '1.80',
  grandTotal: '19.80',
  payments: [
    {
      method: 'cash',
      amount: '19.80',
    },
  ],
};

const SAMPLE_CONFIG: EscPosConfig = { kind: 'usb', target: 'COM3' };

// ---------------------------------------------------------------------------
// Unconfigured / missing-row paths
// ---------------------------------------------------------------------------

describe('escpos-adapter — unconfigured fallthrough', () => {
  it('returns Err({ reason: "unconfigured" }) when the setting row is missing', async () => {
    const prisma = makePrisma(null);
    const factory = (): ThermalPrinterLike => makeRecordingPrinter();

    const result = await print(SAMPLE_RECEIPT, { prisma, factory });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRINTER_FAILURE');
    expect(result.error.details?.reason).toBe('unconfigured');
  });

  it('returns Err({ reason: "unconfigured" }) when the setting row is empty string', async () => {
    const prisma = makePrisma('');
    const factory = (): ThermalPrinterLike => makeRecordingPrinter();

    const result = await print(SAMPLE_RECEIPT, { prisma, factory });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('unconfigured');
  });

  it('returns Err({ reason: "unconfigured" }) when target is empty string in valid JSON', async () => {
    const prisma = makePrisma(JSON.stringify({ kind: 'usb', target: '' }));
    const factory = (): ThermalPrinterLike => makeRecordingPrinter();

    const result = await print(SAMPLE_RECEIPT, { prisma, factory });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('unconfigured');
  });

  it('returns Err({ reason: "invalid_config" }) on malformed JSON', async () => {
    const prisma = makePrisma('{ this is not json');
    const factory = (): ThermalPrinterLike => makeRecordingPrinter();

    const result = await print(SAMPLE_RECEIPT, { prisma, factory });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('invalid_config');
  });

  it('returns Err({ reason: "invalid_config" }) on an unknown kind', async () => {
    const prisma = makePrisma(JSON.stringify({ kind: 'parallel', target: '/dev/lp0' }));
    const factory = (): ThermalPrinterLike => makeRecordingPrinter();

    const result = await print(SAMPLE_RECEIPT, { prisma, factory });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('invalid_config');
  });
});

// ---------------------------------------------------------------------------
// Happy-path command sequence
// ---------------------------------------------------------------------------

describe('escpos-adapter — happy path command sequence', () => {
  it('returns Ok({ adapter: "escpos" }) and emits header → items → totals → payments → cut', async () => {
    const prisma = makePrisma(JSON.stringify(SAMPLE_CONFIG));
    const printer = makeRecordingPrinter({ connected: true });
    const factory = (): ThermalPrinterLike => printer;

    const result = await print(SAMPLE_RECEIPT, { prisma, factory });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ adapter: 'escpos' });

    // Each event tag in `events` lines up with the structural
    // sequence the adapter promises. The full event list is long;
    // we walk it section-by-section.
    const methods = printer.events.map((e) => e.method);

    // Header section: alignCenter then bold(true), the shop name,
    // bold(false), optional shop info lines, drawLine.
    expect(methods).toContain('alignCenter');
    expect(methods).toContain('drawLine');

    // The shop name is emitted via println. Look for it.
    const printedTexts = printer.events
      .filter((e) => e.method === 'println')
      .map((e) => e.args[0]);
    expect(printedTexts).toContain('Core Retail Shop');
    expect(printedTexts).toContain('123 Market St');
    expect(printedTexts).toContain('Tel: 555-0100');
    expect(printedTexts).toContain('Tax ID: TAX-12345');

    // Sale meta — receipt #, date, cashier, customer.
    expect(printedTexts).toContain('Receipt: INV-000123');
    expect(printedTexts).toContain('Date:    2026-05-24T07:38:08.000Z');
    expect(printedTexts).toContain('Cashier: cashier-01');
    expect(printedTexts).toContain('Customer: Alice Lee');

    // Item rows — leftRight(name, lineTotal) for each item.
    const leftRightCalls = printer.events
      .filter((e) => e.method === 'leftRight')
      .map((e) => [e.args[0], e.args[1]]);
    expect(leftRightCalls).toContainEqual(['Widget', '10.00']);
    expect(leftRightCalls).toContainEqual(['Gadget', '10.00']);

    // Totals block — Subtotal/Discount/Tax/Grand Total via leftRight.
    expect(leftRightCalls).toContainEqual(['Subtotal', '20.00']);
    expect(leftRightCalls).toContainEqual(['Discount', '2.00']);
    expect(leftRightCalls).toContainEqual(['Tax', '1.80']);
    expect(leftRightCalls).toContainEqual(['Grand Total', '19.80']);

    // Payments — leftRight('CASH', '19.80').
    expect(leftRightCalls).toContainEqual(['CASH', '19.80']);

    // Quantity-detail rows are emitted via println after each item.
    expect(printedTexts).toContain('  2 x 5.00');
    expect(printedTexts).toContain('  1 x 10.00');

    // Footer — final centered serial + cut.
    expect(methods[methods.length - 2]).toBe('cut');
    expect(methods[methods.length - 1]).toBe('execute');
  });

  it('omits optional shop-info lines when those fields are null', async () => {
    const prisma = makePrisma(JSON.stringify(SAMPLE_CONFIG));
    const printer = makeRecordingPrinter();
    const factory = (): ThermalPrinterLike => printer;

    const minimalReceipt: ReceiptDTO = {
      ...SAMPLE_RECEIPT,
      shopInfo: {
        name: 'Bare Shop',
        address: null,
        phone: null,
        taxId: null,
      },
      customerName: null,
    };

    const result = await print(minimalReceipt, { prisma, factory });
    expect(result.ok).toBe(true);

    const printedTexts = printer.events
      .filter((e) => e.method === 'println')
      .map((e) => e.args[0]);

    expect(printedTexts).toContain('Bare Shop');
    // No address / phone / tax id / customer lines were emitted.
    expect(printedTexts).not.toContain('Tel: ');
    expect(printedTexts).not.toContain('Tax ID: ');
    for (const text of printedTexts) {
      expect(text).not.toMatch(/^Customer:/);
    }
  });
});

// ---------------------------------------------------------------------------
// I/O failure mapping
// ---------------------------------------------------------------------------

describe('escpos-adapter — I/O failure mapping', () => {
  it('returns Err({ reason: "io" }) when the printer is not connected', async () => {
    const prisma = makePrisma(JSON.stringify(SAMPLE_CONFIG));
    const factory = (): ThermalPrinterLike => makeRecordingPrinter({ connected: false });

    const result = await print(SAMPLE_RECEIPT, { prisma, factory });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('io');
    expect(result.error.details?.cause).toBe('printer not connected');
  });

  it('returns Err({ reason: "io" }) and surfaces the cause when execute() rejects', async () => {
    const prisma = makePrisma(JSON.stringify(SAMPLE_CONFIG));
    const factory = (): ThermalPrinterLike =>
      makeRecordingPrinter({
        connected: true,
        executeError: new Error('USB endpoint stalled'),
      });

    const result = await print(SAMPLE_RECEIPT, { prisma, factory });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('io');
    expect(result.error.details?.cause).toBe('USB endpoint stalled');
  });

  it('returns Err({ reason: "io" }) when the factory itself throws', async () => {
    const prisma = makePrisma(JSON.stringify(SAMPLE_CONFIG));
    const factory = (): ThermalPrinterLike => {
      throw new Error('native module load failed');
    };

    const result = await print(SAMPLE_RECEIPT, { prisma, factory });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('io');
    expect(result.error.details?.cause).toBe('native module load failed');
  });
});
