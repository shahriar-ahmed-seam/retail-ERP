// tests/unit/main/printing/pdf-adapter.test.ts
//
// Phase 8, task 8.4 — PDF printer adapter unit tests.
//
// The PDF adapter is the LAST-RESORT link in the chain — its only
// failure mode is a true filesystem error. The unit tests therefore
// focus on:
//
//   1. Producing a real PDF file at `<baseDir>/receipts/<serialNo>.pdf`
//      with the expected `%PDF-` magic header. The adapter is driven
//      against a real `pdfkit` + `node:fs`; only the userData base
//      directory is overridden via the `baseDir` option.
//
//   2. Returning the absolute path of the written file as the
//      `output` field of the `Ok` envelope so the post-commit hook
//      can surface a "saved to ..." log line.
//
//   3. Mapping any thrown exception inside the pipeline (write
//      stream construction, stream `error` event, pdfkit invocation)
//      to `Err({ reason: 'io', cause })`.
//
// Validates: Requirement 4.8.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  print,
  type FsLike,
  type PdfDocLike,
  type PdfKitLike,
} from '@main/printing/pdf-adapter';

import type { ReceiptDTO } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Fixtures
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
  ],
  subtotal: '10.00',
  discount: '0',
  taxTotal: '1.00',
  grandTotal: '11.00',
  payments: [{ method: 'cash', amount: '11.00' }],
};

let testBaseDir: string;

beforeEach(() => {
  testBaseDir = mkdtempSync(join(tmpdir(), 'pdf-adapter-test-'));
});

afterEach(() => {
  rmSync(testBaseDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('pdf-adapter — happy path', () => {
  it('writes a PDF file at <baseDir>/receipts/<serialNo>.pdf with the %PDF- magic header', async () => {
    const result = await print(SAMPLE_RECEIPT, { baseDir: testBaseDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.adapter).toBe('pdf');

    const expectedPath = join(testBaseDir, 'receipts', 'INV-000123.pdf');
    expect(result.value.output).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // Magic header — every PDF document starts with `%PDF-` followed
    // by the format version. We only assert the prefix.
    const buf = readFileSync(expectedPath);
    expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('uses the userData loader override when no baseDir is supplied', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-adapter-userdata-'));
    try {
      const result = await print(SAMPLE_RECEIPT, {
        userDataLoader: () => userDataDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const expectedPath = join(userDataDir, 'receipts', 'INV-000123.pdf');
      expect(result.value.output).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('falls back to os.tmpdir() when both baseDir and userDataLoader are absent', async () => {
    const result = await print(
      { ...SAMPLE_RECEIPT, serialNo: 'INV-000999' },
      { userDataLoader: () => null },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.output === undefined) {
      throw new Error('expected an output path on the PDF Ok envelope');
    }

    expect(result.value.output).toContain('core-retail-erp-receipts');
    expect(result.value.output.endsWith('INV-000999.pdf')).toBe(true);
    expect(existsSync(result.value.output)).toBe(true);

    // Cleanup so the tmp dir does not accumulate test artifacts.
    rmSync(result.value.output, { force: true });
  });

  it('sanitizes serial numbers with non-alphanumeric characters', async () => {
    const sanitizedReceipt: ReceiptDTO = {
      ...SAMPLE_RECEIPT,
      serialNo: 'INV/000 123',
    };

    const result = await print(sanitizedReceipt, { baseDir: testBaseDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.output === undefined) {
      throw new Error('expected an output path on the PDF Ok envelope');
    }

    // `/` and ` ` collapse to `_` per the adapter's sanitization
    // rule, so the on-disk filename is `INV_000_123.pdf`.
    expect(result.value.output.endsWith('INV_000_123.pdf')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

describe('pdf-adapter — failure mapping', () => {
  it('returns Err({ reason: "io" }) when createWriteStream throws', async () => {
    const fs: FsLike = {
      createWriteStream: () => {
        throw new Error('EACCES: permission denied');
      },
    };

    const result = await print(SAMPLE_RECEIPT, { baseDir: testBaseDir, fs });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PRINTER_FAILURE');
    expect(result.error.details?.reason).toBe('io');
    expect(result.error.details?.cause).toBe('EACCES: permission denied');
  });

  it('returns Err({ reason: "io" }) when the pdfkit constructor throws', async () => {
    const failingPdfKit: PdfKitLike = function (): PdfDocLike {
      throw new Error('pdfkit init failed');
    } as unknown as PdfKitLike;

    const result = await print(SAMPLE_RECEIPT, {
      baseDir: testBaseDir,
      pdfKitLoader: () => failingPdfKit,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details?.reason).toBe('io');
    expect(result.error.details?.cause).toBe('pdfkit init failed');
  });
});
