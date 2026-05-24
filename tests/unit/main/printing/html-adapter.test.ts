// tests/unit/main/printing/html-adapter.test.ts
//
// Phase 8, task 8.3 — HTML printer adapter unit tests.
//
// Two surfaces under test:
//
//   1. `print(receipt)` returns `Err({ reason: 'electron_unavailable' })`
//      when the Electron loader returns `null` (test environment, or
//      pre-`app.ready` bootstrap). The chain falls through to PDF on
//      this code.
//
//   2. With a recording stub for the Electron module, the adapter
//      drives the offscreen `BrowserWindow` lifecycle correctly:
//      load the data URL, wait for `did-finish-load`, dispatch
//      `webContents.print` with `{ silent: true, deviceName: '' }`,
//      destroy the window. `Ok({ adapter: 'html' })` on success;
//      `Err({ reason: 'io', cause })` when the print callback fires
//      with `false`.
//
//   3. The exported `buildReceiptHtml` produces a self-contained
//      HTML document containing the shop name, every line item,
//      every payment, and the totals block — i.e. enough content
//      that the rendered page is correct.
//
// Validates: Requirement 4.8.

import { describe, expect, it } from 'vitest';

import {
  buildReceiptHtml,
  escapeHtml,
  print,
  type ElectronAppLike,
  type ElectronBrowserWindowLike,
  type ElectronModuleLike,
  type ElectronWebContentsLike,
} from '@main/printing/html-adapter';

import type { ReceiptDTO } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

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
    { method: 'cash', amount: '12.00' },
    { method: 'card', amount: '7.80' },
  ],
};

interface RecordingState {
  loadedUrls: string[];
  printCalls: { silent: boolean; deviceName?: string }[];
  destroyed: boolean;
  printResult: { success: boolean; failureReason?: string };
  loadShouldThrow?: Error;
  appReady: boolean;
}

/**
 * Build an Electron stub. The webContents stub fires the
 * `did-finish-load` event synchronously when the listener registers
 * (in real Electron the event is async; for tests this collapses
 * the lifecycle into a single tick which keeps the assertions
 * straightforward).
 */
function makeElectronStub(state: RecordingState): ElectronModuleLike {
  let finishHandler: (() => void) | null = null;

  const webContents: ElectronWebContentsLike = {
    loadURL(url: string): Promise<void> {
      state.loadedUrls.push(url);
      // Simulate the navigation completing on the next microtask
      // and firing did-finish-load.
      return Promise.resolve().then(() => {
        if (state.loadShouldThrow !== undefined) {
          throw state.loadShouldThrow;
        }
        finishHandler?.();
      });
    },
    once(event: 'did-finish-load', listener: () => void): ElectronWebContentsLike {
      if (event === 'did-finish-load') {
        finishHandler = listener;
      }
      return webContents;
    },
    print(
      options: { silent: boolean; deviceName?: string },
      callback: (success: boolean, failureReason?: string) => void,
    ): void {
      state.printCalls.push(options);
      // Defer to next tick so the promise wrapper inside the adapter
      // has a chance to wire up.
      void Promise.resolve().then(() => {
        callback(state.printResult.success, state.printResult.failureReason);
      });
    },
  };

  const window: ElectronBrowserWindowLike = {
    webContents,
    destroy(): void {
      state.destroyed = true;
    },
    isDestroyed(): boolean {
      return state.destroyed;
    },
  };

  const app: ElectronAppLike = {
    isReady: () => state.appReady,
  };

  return {
    app,
    BrowserWindow: function (): ElectronBrowserWindowLike {
      return window;
    } as unknown as ElectronModuleLike['BrowserWindow'],
  };
}

// ---------------------------------------------------------------------------
// Electron unavailable
// ---------------------------------------------------------------------------

describe('html-adapter — Electron unavailable', () => {
  it('returns Err({ reason: "electron_unavailable" }) when the loader returns null', async () => {
    const result = await print(SAMPLE_RECEIPT, { loadElectron: () => null });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRINTER_FAILURE');
    expect(result.error.details?.reason).toBe('electron_unavailable');
  });

  it('returns Err({ reason: "electron_unavailable" }) when the app is not yet ready', async () => {
    const state: RecordingState = {
      loadedUrls: [],
      printCalls: [],
      destroyed: false,
      printResult: { success: true },
      appReady: false,
    };
    const result = await print(SAMPLE_RECEIPT, {
      loadElectron: () => makeElectronStub(state),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('electron_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('html-adapter — happy path', () => {
  it('returns Ok({ adapter: "html" }) and dispatches webContents.print silently', async () => {
    const state: RecordingState = {
      loadedUrls: [],
      printCalls: [],
      destroyed: false,
      printResult: { success: true },
      appReady: true,
    };

    const result = await print(SAMPLE_RECEIPT, {
      loadElectron: () => makeElectronStub(state),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ adapter: 'html' });

    // Loaded a single data URL.
    expect(state.loadedUrls).toHaveLength(1);
    expect(state.loadedUrls[0]).toMatch(/^data:text\/html;base64,/);

    // Dispatched print with silent + deviceName.
    expect(state.printCalls).toHaveLength(1);
    const printCall = state.printCalls[0];
    if (printCall === undefined) throw new Error('expected a print call');
    expect(printCall.silent).toBe(true);

    // Destroyed the window during teardown.
    expect(state.destroyed).toBe(true);
  });

  it('encodes the rendered HTML into the loaded data URL', async () => {
    const state: RecordingState = {
      loadedUrls: [],
      printCalls: [],
      destroyed: false,
      printResult: { success: true },
      appReady: true,
    };

    await print(SAMPLE_RECEIPT, {
      loadElectron: () => makeElectronStub(state),
    });

    const loadedUrl = state.loadedUrls[0];
    if (loadedUrl === undefined) throw new Error('expected a loaded URL');
    const base64 = loadedUrl.replace(/^data:text\/html;base64,/, '');
    const decoded = Buffer.from(base64, 'base64').toString('utf8');

    expect(decoded).toContain('Core Retail Shop');
    expect(decoded).toContain('INV-000123');
    expect(decoded).toContain('Widget');
    expect(decoded).toContain('Gadget');
    expect(decoded).toContain('CASH');
    expect(decoded).toContain('CARD');
  });
});

// ---------------------------------------------------------------------------
// Print failure
// ---------------------------------------------------------------------------

describe('html-adapter — print failure', () => {
  it('returns Err({ reason: "io", cause }) when the print callback reports failure', async () => {
    const state: RecordingState = {
      loadedUrls: [],
      printCalls: [],
      destroyed: false,
      printResult: { success: false, failureReason: 'no printers found' },
      appReady: true,
    };

    const result = await print(SAMPLE_RECEIPT, {
      loadElectron: () => makeElectronStub(state),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('io');
    expect(result.error.details?.cause).toBe('no printers found');
    expect(state.destroyed).toBe(true);
  });

  it('returns Err({ reason: "io" }) when loadURL throws', async () => {
    const state: RecordingState = {
      loadedUrls: [],
      printCalls: [],
      destroyed: false,
      printResult: { success: true },
      loadShouldThrow: new Error('navigation aborted'),
      appReady: true,
    };

    const result = await print(SAMPLE_RECEIPT, {
      loadElectron: () => makeElectronStub(state),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('io');
    expect(result.error.details?.cause).toBe('navigation aborted');
    expect(state.destroyed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTML template content
// ---------------------------------------------------------------------------

describe('buildReceiptHtml', () => {
  it('contains the shop name, every line item, every payment, and the totals block', () => {
    const html = buildReceiptHtml(SAMPLE_RECEIPT);

    // Header
    expect(html).toContain('Core Retail Shop');
    expect(html).toContain('123 Market St');
    expect(html).toContain('Tel: 555-0100');
    expect(html).toContain('Tax ID: TAX-12345');

    // Sale meta
    expect(html).toContain('INV-000123');
    expect(html).toContain('2026-05-24T07:38:08.000Z');
    expect(html).toContain('cashier-01');
    expect(html).toContain('Alice Lee');

    // Each line item — name, quantity x unit, lineTotal.
    expect(html).toContain('Widget');
    expect(html).toContain('Gadget');
    expect(html).toContain('2 x 5.00');
    expect(html).toContain('1 x 10.00');

    // Totals block
    expect(html).toContain('Subtotal');
    expect(html).toContain('20.00');
    expect(html).toContain('Discount');
    expect(html).toContain('2.00');
    expect(html).toContain('Tax');
    expect(html).toContain('1.80');
    expect(html).toContain('Grand Total');
    expect(html).toContain('19.80');

    // Every payment
    expect(html).toContain('CASH');
    expect(html).toContain('12.00');
    expect(html).toContain('CARD');
    expect(html).toContain('7.80');
  });

  it('omits optional shop-info and customer lines when those fields are null', () => {
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

    const html = buildReceiptHtml(minimalReceipt);

    expect(html).toContain('Bare Shop');
    expect(html).not.toContain('Tel:');
    expect(html).not.toContain('Tax ID:');
    expect(html).not.toContain('Customer:');
  });

  it('escapes special characters in untrusted strings', () => {
    const xssReceipt: ReceiptDTO = {
      ...SAMPLE_RECEIPT,
      shopInfo: {
        ...SAMPLE_RECEIPT.shopInfo,
        name: '<script>alert(1)</script>',
      },
      customerName: 'Bob & Alice',
      lines: [
        {
          name: '"Quoted" Item',
          quantity: 1,
          unitPrice: '1.00',
          lineTotal: '1.00',
          taxRate: '0',
        },
      ],
    };

    const html = buildReceiptHtml(xssReceipt);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Bob &amp; Alice');
    expect(html).toContain('&quot;Quoted&quot; Item');
  });
});

describe('escapeHtml', () => {
  it('escapes &, <, >, ", and \'', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('<x>')).toBe('&lt;x&gt;');
    expect(escapeHtml(`"x"`)).toBe('&quot;x&quot;');
    expect(escapeHtml(`'x'`)).toBe('&#39;x&#39;');
  });
});
