// tests/unit/main/printing/printer.test.ts
//
// Phase 8, task 8.5 — ChainAdapter + selectPrinter + postCommitPrint
// unit tests.
//
// Three surfaces under test:
//
//   1. `runChain(adapters, receipt)` walks the adapters in order and
//      returns the first `Ok`. On every `Err`, the chain falls
//      through to the next adapter. If every adapter returns `Err`,
//      the chain returns the LAST adapter's envelope.
//
//   2. `selectPrinter()` returns a chain wired to ESC/POS → HTML →
//      PDF in that order — a structural assertion against the
//      `adapters[].name` field; we don't drive the real adapters
//      here.
//
//   3. `postCommitPrint(sale, prisma, options)` integrates the
//      shop-info loader, receipt builder, and chain. Tests inject
//      stubs for each and assert the call sequence (loadShopInfo →
//      buildReceipt → chain.print). When the chain returns `Err`
//      the helper logs via `errorSink`; when the chain returns `Ok`
//      no log fires. The helper NEVER throws.
//
// Validates: Requirements 4.7, 4.8, 4.9.

import { describe, expect, it } from 'vitest';

import {
  postCommitPrint,
  printReceipt,
  runChain,
  selectPrinter,
} from '@main/printing/printer';
import { Err, Ok } from '@shared/result.js';

import type { PrinterAdapter, PrintResult } from '@main/printing/types';
import type {
  ReceiptDTO,
  ReceiptShopInfo,
  SaleDTO,
} from '@shared/dto/index.js';
import type { ErrorEnvelope, Result } from '@shared/result.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_RECEIPT: ReceiptDTO = {
  shopInfo: {
    name: 'Core Retail Shop',
    address: null,
    phone: null,
    taxId: null,
  },
  serialNo: 'INV-000123',
  createdAt: '2026-05-24T07:38:08.000Z',
  cashierName: 'cashier-01',
  customerName: null,
  lines: [],
  subtotal: '0',
  discount: '0',
  taxTotal: '0',
  grandTotal: '0',
  payments: [],
};

const SAMPLE_SALE: SaleDTO = {
  id: 'sale-1',
  serialNo: 'INV-000123',
  customerId: null,
  customerName: null,
  cashierId: 'user-1',
  cashierName: 'cashier-01',
  subtotal: '0',
  discount: '0',
  taxTotal: '0',
  grandTotal: '0',
  createdAt: '2026-05-24T07:38:08.000Z',
  items: [],
  payments: [],
};

const SAMPLE_SHOP_INFO: ReceiptShopInfo = {
  name: 'Core Retail Shop',
  address: null,
  phone: null,
  taxId: null,
};

// ---------------------------------------------------------------------------
// Adapter stubs
// ---------------------------------------------------------------------------

interface RecordingAdapter extends PrinterAdapter {
  readonly calls: ReceiptDTO[];
}

function makeAdapter(
  name: PrinterAdapter['name'],
  result: Result<PrintResult>,
): RecordingAdapter {
  const calls: ReceiptDTO[] = [];
  return {
    name,
    calls,
    print(receipt: ReceiptDTO): Promise<Result<PrintResult>> {
      calls.push(receipt);
      return Promise.resolve(result);
    },
  };
}

// ---------------------------------------------------------------------------
// runChain
// ---------------------------------------------------------------------------

describe('runChain', () => {
  it('returns the first adapter Ok and short-circuits the rest', async () => {
    const a = makeAdapter('escpos', Ok({ adapter: 'escpos' }));
    const b = makeAdapter('html', Ok({ adapter: 'html' }));
    const c = makeAdapter('pdf', Ok({ adapter: 'pdf' }));

    const result = await runChain([a, b, c], SAMPLE_RECEIPT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ adapter: 'escpos' });

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(c.calls).toHaveLength(0);
  });

  it('falls through to the next adapter when the first returns Err', async () => {
    const a = makeAdapter(
      'escpos',
      Err('PRINTER_FAILURE', { reason: 'unconfigured' }),
    );
    const b = makeAdapter('html', Ok({ adapter: 'html' }));
    const c = makeAdapter('pdf', Ok({ adapter: 'pdf' }));

    const result = await runChain([a, b, c], SAMPLE_RECEIPT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ adapter: 'html' });

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(c.calls).toHaveLength(0);
  });

  it('returns the LAST adapter Err when every adapter fails', async () => {
    const a = makeAdapter(
      'escpos',
      Err('PRINTER_FAILURE', { reason: 'unconfigured' }),
    );
    const b = makeAdapter(
      'html',
      Err('PRINTER_FAILURE', { reason: 'electron_unavailable' }),
    );
    const c = makeAdapter(
      'pdf',
      Err('PRINTER_FAILURE', { reason: 'io', cause: 'ENOSPC' }),
    );

    const result = await runChain([a, b, c], SAMPLE_RECEIPT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRINTER_FAILURE');
    expect(result.error.details?.reason).toBe('io');
    expect(result.error.details?.cause).toBe('ENOSPC');

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(c.calls).toHaveLength(1);
  });

  it('returns Err on an empty adapters list', async () => {
    const result = await runChain([], SAMPLE_RECEIPT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRINTER_FAILURE');
  });
});

// ---------------------------------------------------------------------------
// selectPrinter
// ---------------------------------------------------------------------------

describe('selectPrinter', () => {
  it('returns a chain wired to escpos → html → pdf in that order', () => {
    const chain = selectPrinter();
    expect(chain.adapters.map((a) => a.name)).toEqual(['escpos', 'html', 'pdf']);
  });
});

// ---------------------------------------------------------------------------
// printReceipt
// ---------------------------------------------------------------------------

describe('printReceipt', () => {
  it('drives the default chain and resolves with the chain Result', async () => {
    // The default chain is escpos → html → pdf. ESC/POS will return
    // `unconfigured` because no Setting row is present (no DB
    // attached in unit tier); HTML will return `electron_unavailable`
    // because Electron is not loaded; PDF will write a file under
    // os.tmpdir(). The Ok envelope therefore has adapter === 'pdf'.
    const result = await printReceipt(SAMPLE_RECEIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The unit-tier doesn't have a real Prisma client; the ESC/POS
    // adapter throws when it tries to look up the config. The chain
    // falls through to the next adapter regardless.
    expect(['escpos', 'html', 'pdf']).toContain(result.value.adapter);
  });
});

// ---------------------------------------------------------------------------
// postCommitPrint
// ---------------------------------------------------------------------------

describe('postCommitPrint', () => {
  it('calls loadShopInfo → buildReceipt → chain.print in that order', async () => {
    const calls: string[] = [];
    const recordedReceipts: ReceiptDTO[] = [];
    const recordedSales: SaleDTO[] = [];
    const recordedShopInfos: ReceiptShopInfo[] = [];

    const chain = {
      adapters: [],
      print(receipt: ReceiptDTO): Promise<Result<PrintResult>> {
        calls.push('chain.print');
        recordedReceipts.push(receipt);
        return Promise.resolve(Ok({ adapter: 'escpos' as const }));
      },
    };

    const loadShopInfo = (): Promise<ReceiptShopInfo> => {
      calls.push('loadShopInfo');
      return Promise.resolve(SAMPLE_SHOP_INFO);
    };

    const buildReceipt = (
      sale: SaleDTO,
      shopInfo: ReceiptShopInfo,
    ): ReceiptDTO => {
      calls.push('buildReceipt');
      recordedSales.push(sale);
      recordedShopInfos.push(shopInfo);
      return SAMPLE_RECEIPT;
    };

    const errorSink = (): void => {
      calls.push('errorSink');
    };

    await postCommitPrint(
      SAMPLE_SALE,
      { setting: { findMany: () => Promise.resolve([]) } },
      {
        chain,
        loadShopInfo,
        buildReceipt,
        errorSink,
        isSuppressed: () => false,
      },
    );

    expect(calls).toEqual(['loadShopInfo', 'buildReceipt', 'chain.print']);
    expect(recordedSales).toEqual([SAMPLE_SALE]);
    expect(recordedShopInfos).toEqual([SAMPLE_SHOP_INFO]);
    expect(recordedReceipts).toEqual([SAMPLE_RECEIPT]);
  });

  it('logs via errorSink when the chain returns Err', async () => {
    const sinkEvents: ErrorEnvelope[] = [];
    const errorSink = (envelope: ErrorEnvelope): void => {
      sinkEvents.push(envelope);
    };

    const chain = {
      adapters: [],
      print(): Promise<Result<PrintResult>> {
        return Promise.resolve(
          Err('PRINTER_FAILURE', { reason: 'io', cause: 'pipe broken' }),
        );
      },
    };

    await postCommitPrint(
      SAMPLE_SALE,
      { setting: { findMany: () => Promise.resolve([]) } },
      {
        chain,
        loadShopInfo: () => Promise.resolve(SAMPLE_SHOP_INFO),
        buildReceipt: () => SAMPLE_RECEIPT,
        errorSink,
        isSuppressed: () => false,
      },
    );

    expect(sinkEvents).toHaveLength(1);
    const event = sinkEvents[0];
    if (event === undefined) throw new Error('expected an error event');
    expect(event.code).toBe('PRINTER_FAILURE');
    expect(event.details?.reason).toBe('io');
  });

  it('does NOT log via errorSink when the chain returns Ok', async () => {
    const sinkEvents: ErrorEnvelope[] = [];
    const errorSink = (envelope: ErrorEnvelope): void => {
      sinkEvents.push(envelope);
    };

    const chain = {
      adapters: [],
      print(): Promise<Result<PrintResult>> {
        return Promise.resolve(Ok({ adapter: 'pdf' as const, output: '/tmp/x.pdf' }));
      },
    };

    await postCommitPrint(
      SAMPLE_SALE,
      { setting: { findMany: () => Promise.resolve([]) } },
      {
        chain,
        loadShopInfo: () => Promise.resolve(SAMPLE_SHOP_INFO),
        buildReceipt: () => SAMPLE_RECEIPT,
        errorSink,
        isSuppressed: () => false,
      },
    );

    expect(sinkEvents).toHaveLength(0);
  });

  it('short-circuits when isSuppressed returns true', async () => {
    let chainCalled = false;
    const chain = {
      adapters: [],
      print(): Promise<Result<PrintResult>> {
        chainCalled = true;
        return Promise.resolve(Ok({ adapter: 'escpos' as const }));
      },
    };

    let loadShopInfoCalled = false;
    await postCommitPrint(
      SAMPLE_SALE,
      { setting: { findMany: () => Promise.resolve([]) } },
      {
        chain,
        loadShopInfo: () => {
          loadShopInfoCalled = true;
          return Promise.resolve(SAMPLE_SHOP_INFO);
        },
        buildReceipt: () => SAMPLE_RECEIPT,
        isSuppressed: () => true,
      },
    );

    expect(chainCalled).toBe(false);
    expect(loadShopInfoCalled).toBe(false);
  });

  it('catches a thrown loadShopInfo and logs via errorSink instead of rejecting', async () => {
    const sinkEvents: ErrorEnvelope[] = [];
    const errorSink = (envelope: ErrorEnvelope): void => {
      sinkEvents.push(envelope);
    };

    await postCommitPrint(
      SAMPLE_SALE,
      { setting: { findMany: () => Promise.resolve([]) } },
      {
        chain: {
          adapters: [],
          print: () => Promise.resolve(Ok({ adapter: 'escpos' as const })),
        },
        loadShopInfo: () => Promise.reject(new Error('db gone')),
        buildReceipt: () => SAMPLE_RECEIPT,
        errorSink,
        isSuppressed: () => false,
      },
    );

    expect(sinkEvents).toHaveLength(1);
    const event = sinkEvents[0];
    if (event === undefined) throw new Error('expected an error event');
    expect(event.code).toBe('PRINTER_FAILURE');
    expect(event.details?.cause).toBe('db gone');
  });

  it('catches a thrown chain.print and logs via errorSink', async () => {
    const sinkEvents: ErrorEnvelope[] = [];
    const errorSink = (envelope: ErrorEnvelope): void => {
      sinkEvents.push(envelope);
    };

    await postCommitPrint(
      SAMPLE_SALE,
      { setting: { findMany: () => Promise.resolve([]) } },
      {
        chain: {
          adapters: [],
          print: () => Promise.reject(new Error('chain exploded')),
        },
        loadShopInfo: () => Promise.resolve(SAMPLE_SHOP_INFO),
        buildReceipt: () => SAMPLE_RECEIPT,
        errorSink,
        isSuppressed: () => false,
      },
    );

    expect(sinkEvents).toHaveLength(1);
    const event = sinkEvents[0];
    if (event === undefined) throw new Error('expected an error event');
    expect(event.details?.cause).toBe('chain exploded');
  });
});
