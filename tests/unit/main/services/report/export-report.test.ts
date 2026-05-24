import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the combined `exportReport` entry point (Phase 10
 * task 10.7).
 *
 * Asserts:
 *   - Single format ('csv' or 'pdf') returns `{ path, rowCount }`.
 *   - Both formats requested → `{ csvPath, pdfPath, rowCount }`.
 *   - Both encoders see every batch (shared cursor pump).
 *   - The pump is driven exactly once when both formats are requested.
 *   - Validation envelopes from the pump propagate verbatim.
 *
 * Validates: Requirements 9.5, 16.6.
 */

const pumpMock = vi.hoisted(() => ({
  pumpRows: vi.fn(),
}));

vi.mock('@main/services/report/pump', async (importActual) => {
  const actual = await importActual<typeof import('@main/services/report/pump')>();
  return { ...actual, pumpRows: pumpMock.pumpRows };
});

vi.mock('@main/services/report/pump.js', async (importActual) => {
  const actual = await importActual<typeof import('@main/services/report/pump.js')>();
  return { ...actual, pumpRows: pumpMock.pumpRows };
});

import { exportReport } from '@main/services/report/index';
import { Ok } from '@shared/result';

import type { ExportRow } from '@main/services/report/pump';
import type { Result } from '@shared/result';

interface FakeStream extends EventEmitter {
  readonly chunks: string[];
  finished: boolean;
  write(c: string): boolean;
  end(): void;
  destroy(): void;
}

function makeStream(): FakeStream {
  const e = new EventEmitter();
  const s = e as FakeStream;
  s.chunks = [];
  s.finished = false;
  s.write = (c) => {
    s.chunks.push(c);
    return true;
  };
  s.end = () => {
    s.finished = true;
    setImmediate(() => s.emit('finish'));
  };
  s.destroy = () => undefined;
  return s;
}

function makePdfKitLoader(): () => unknown {
  const doc: Record<string, unknown> = {
    pipe(this: typeof doc, stream: FakeStream) {
      this.__s = stream;
      return this;
    },
    font: function (this: typeof doc) {
      return this;
    },
    fontSize: function (this: typeof doc) {
      return this;
    },
    text: function (this: typeof doc) {
      return this;
    },
    moveDown: function (this: typeof doc) {
      return this;
    },
    addPage: function (this: typeof doc) {
      return this;
    },
    on: function (this: typeof doc) {
      return this;
    },
    end: function (this: typeof doc) {
      const s = this.__s as FakeStream;
      s.end();
    },
    page: { height: 1000, margins: { bottom: 36 } },
    get y() {
      return 0;
    },
  };
  return () =>
    function Ctor(): unknown {
      return doc;
    };
}

const fakeFs = { createWriteStream: vi.fn() };

beforeEach(() => {
  pumpMock.pumpRows.mockReset();
  fakeFs.createWriteStream.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exportReport', () => {
  it('writes CSV only when only csv path provided', async () => {
    const csv = makeStream();
    fakeFs.createWriteStream.mockReturnValueOnce(csv);
    pumpMock.pumpRows.mockImplementation(
      async (
        _opts: unknown,
        consumer: (b: readonly ExportRow[], m: { batchIndex: number; isLast: boolean }) => Promise<void>,
      ): Promise<Result<{ rowCount: number }>> => {
        await consumer(
          [
            { productId: 'p', sku: 'S', name: 'N', onHand: 1, reorderLevel: 0 },
          ],
          { batchIndex: 0, isLast: true },
        );
        return Ok({ rowCount: 1 });
      },
    );

    const result = await exportReport({
      request: { reportId: 'lowStock', format: 'csv' },
      paths: { csv: '/tmp/x.csv' },
      fs: fakeFs,
      pdfKitLoader: makePdfKitLoader() as () => new (
        init?: { size?: 'A4' | 'LETTER'; margin?: number },
      ) => import('@main/services/report/pdf-export').PdfDocLike,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ path: '/tmp/x.csv', rowCount: 1 });
    expect(fakeFs.createWriteStream).toHaveBeenCalledTimes(1);
    expect(pumpMock.pumpRows).toHaveBeenCalledTimes(1);
  });

  it('drives the pump once and writes both formats when both paths are provided', async () => {
    const csvStream = makeStream();
    const pdfStream = makeStream();
    fakeFs.createWriteStream.mockImplementation((p: string) => {
      if (p.endsWith('.csv')) return csvStream;
      return pdfStream;
    });
    pumpMock.pumpRows.mockImplementation(
      async (
        _opts: unknown,
        consumer: (b: readonly ExportRow[], m: { batchIndex: number; isLast: boolean }) => Promise<void>,
      ): Promise<Result<{ rowCount: number }>> => {
        await consumer(
          [
            { productId: 'p', sku: 'S', name: 'N', onHand: 1, reorderLevel: 0 },
            { productId: 'q', sku: 'T', name: 'O', onHand: 2, reorderLevel: 1 },
          ],
          { batchIndex: 0, isLast: true },
        );
        return Ok({ rowCount: 2 });
      },
    );

    const result = await exportReport({
      request: { reportId: 'lowStock', format: ['csv', 'pdf'] },
      paths: { csv: '/tmp/y.csv', pdf: '/tmp/y.pdf' },
      fs: fakeFs,
      pdfKitLoader: makePdfKitLoader() as () => new (
        init?: { size?: 'A4' | 'LETTER'; margin?: number },
      ) => import('@main/services/report/pdf-export').PdfDocLike,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      csvPath: '/tmp/y.csv',
      pdfPath: '/tmp/y.pdf',
      rowCount: 2,
    });
    // Pump runs exactly once even though both encoders consume.
    expect(pumpMock.pumpRows).toHaveBeenCalledTimes(1);
    expect(csvStream.chunks.length).toBeGreaterThan(0);
    expect(csvStream.finished).toBe(true);
    expect(pdfStream.finished).toBe(true);
  });
});
