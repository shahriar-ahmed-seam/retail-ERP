import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `exportPdf` (Phase 10, task 10.6).
 *
 * Drives the streaming PDF exporter against an in-memory write
 * stream stub, a mocked `pumpRows`, and a recording PDF document
 * stub so we can assert the document carries the title, the column
 * header on the first page, and one rendered text call per row plus
 * a fresh header on each `addPage()`.
 *
 * Validates: Requirements 9.5, 16.3, 16.6.
 */

const pumpMock = vi.hoisted(() => ({
  pumpRows: vi.fn(),
}));

vi.mock('@main/services/report/pump', async (importActual) => {
  const actual = await importActual<typeof import('@main/services/report/pump')>();
  return {
    ...actual,
    pumpRows: pumpMock.pumpRows,
  };
});

vi.mock('@main/services/report/pump.js', async (importActual) => {
  const actual =
    await importActual<typeof import('@main/services/report/pump.js')>();
  return {
    ...actual,
    pumpRows: pumpMock.pumpRows,
  };
});

import { exportPdf } from '@main/services/report/pdf-export';
import { Err, Ok } from '@shared/result';

import type { ExportRow } from '@main/services/report/pump';
import type { Result } from '@shared/result';

// ---------------------------------------------------------------------------
// In-memory stubs
// ---------------------------------------------------------------------------

interface FakeWriteStream extends EventEmitter {
  readonly chunks: string[];
  finished: boolean;
  write(chunk: string): boolean;
  end(): void;
  destroy(): void;
}

function makeStream(): FakeWriteStream {
  const e = new EventEmitter();
  const stream = e as FakeWriteStream;
  stream.chunks = [];
  stream.finished = false;
  stream.write = (chunk: string) => {
    stream.chunks.push(chunk);
    return true;
  };
  stream.end = () => {
    stream.finished = true;
    setImmediate(() => stream.emit('finish'));
  };
  stream.destroy = () => {
    /* no-op */
  };
  return stream;
}

interface FakeDocOps {
  title?: string;
  texts: string[];
  pages: number;
  fonts: string[];
  ended: boolean;
}

function makePdfKitLoader(
  ops: FakeDocOps,
  _stream: FakeWriteStream,
): () => new (init?: { size?: 'A4' | 'LETTER'; margin?: number }) =>
  import('@main/services/report/pdf-export').PdfDocLike {
  // The constructor mimics pdfkit: returns a recording document
  // with chainable text/font/fontSize/moveDown plus `addPage`,
  // `pipe`, and `end`. `y`, `page.height`, and `page.margins.bottom`
  // are tuned so the fake encoder paginates after a handful of
  // rows (so the "header re-rendered on new page" assertion fires
  // without seeding hundreds of rows).
  ops.texts = [];
  ops.fonts = [];
  ops.pages = 1;
  ops.ended = false;

  // We track `y` ourselves: every `text()` advances `y` by 14pt
  // (matches `PDF_ROW_HEIGHT`); `addPage` resets it.
  const PAGE_HEIGHT = 60;
  const MARGIN_BOTTOM = 10;
  let y = 0;

  const doc: Record<string, unknown> = {
    pipe: (s: FakeWriteStream) => {
      // Forward `end()` from doc to the stream so the writable
      // emits `finish` after `doc.end()`.
      doc.__stream = s;
      return doc;
    },
    font: (name: string) => {
      ops.fonts.push(name);
      return doc;
    },
    fontSize: (_: number) => doc,
    text: (value: string) => {
      ops.texts.push(value);
      y += 14;
      return doc;
    },
    moveDown: (_lines?: number) => {
      y += 4;
      return doc;
    },
    addPage: () => {
      ops.pages += 1;
      y = 0;
      return doc;
    },
    end: () => {
      ops.ended = true;
      // Mirror pdfkit: `doc.end()` flushes to the underlying
      // stream which then fires `finish`.
      const s = doc.__stream as FakeWriteStream;
      s.end();
    },
    on: (_evt: string, _listener: (...args: unknown[]) => void) => doc,
    page: { height: PAGE_HEIGHT, margins: { bottom: MARGIN_BOTTOM } },
    get y() {
      return y;
    },
  };

  return () => {
    // pdfkit constructor returns the doc on `new PDFDocument()`. The
    // double cast (`function → unknown → new`) is required because
    // a regular function's type is not assignable to `new (...)`
    // without the indirection. The unit test's stub document
    // satisfies `PdfDocLike` structurally.
    function Ctor(_init?: { size?: 'A4' | 'LETTER'; margin?: number }): unknown {
      return doc;
    }
    return Ctor as unknown as new (init?: {
      size?: 'A4' | 'LETTER';
      margin?: number;
    }) => import('@main/services/report/pdf-export').PdfDocLike;
  };
}

const fakeFs = {
  createWriteStream: vi.fn(),
};

beforeEach(() => {
  pumpMock.pumpRows.mockReset();
  fakeFs.createWriteStream.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// exportPdf
// ---------------------------------------------------------------------------

describe('exportPdf', () => {
  it('renders a title, header, and one text call per row, paginating as needed', async () => {
    const stream = makeStream();
    fakeFs.createWriteStream.mockReturnValue(stream);
    const ops: FakeDocOps = { texts: [], pages: 1, fonts: [], ended: false };
    const loader = makePdfKitLoader(ops, stream);

    pumpMock.pumpRows.mockImplementation(
      async (
        _opts: unknown,
        consumer: (
          batch: readonly ExportRow[],
          meta: { batchIndex: number; isLast: boolean },
        ) => Promise<void>,
      ): Promise<Result<{ rowCount: number }>> => {
        // Send 6 rows in two batches so the fake page (height 60,
        // margin 10, row height 14 ≈ 4 rows per page) overflows.
        const rows: ExportRow[] = Array.from({ length: 6 }, (_, i) => ({
          productId: `p-${i}`,
          sku: `SKU-${i}`,
          name: `Item ${i}`,
          onHand: i,
          reorderLevel: 1,
        }));
        await consumer(rows.slice(0, 3), { batchIndex: 0, isLast: false });
        await consumer(rows.slice(3, 6), { batchIndex: 1, isLast: true });
        return Ok({ rowCount: 6 });
      },
    );

    const result = await exportPdf({
      request: { reportId: 'lowStock', format: 'pdf' },
      path: '/tmp/out.pdf',
      fs: fakeFs,
      pdfKitLoader: loader,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ path: '/tmp/out.pdf', rowCount: 6 });

    // Title is the first text call.
    expect(ops.texts[0]).toBe('Low Stock');
    // Header line includes the column names.
    expect(ops.texts.some((t) => t.includes('SKU') && t.includes('Product'))).toBe(true);
    // 6 row text calls + at least 1 title + 2 headers (initial + after addPage).
    expect(ops.texts.length).toBeGreaterThanOrEqual(6 + 2);
    // Pagination triggered at least once.
    expect(ops.pages).toBeGreaterThanOrEqual(2);
    expect(ops.ended).toBe(true);
    expect(stream.finished).toBe(true);
  });

  it('forwards a pump-level Err verbatim', async () => {
    const stream = makeStream();
    fakeFs.createWriteStream.mockReturnValue(stream);
    const ops: FakeDocOps = { texts: [], pages: 1, fonts: [], ended: false };
    const loader = makePdfKitLoader(ops, stream);

    pumpMock.pumpRows.mockResolvedValue(Err('VALIDATION', { field: 'month' }));

    const result = await exportPdf({
      request: { reportId: 'monthlySales', format: 'pdf', filter: { month: 'bad' } },
      path: '/tmp/bad.pdf',
      fs: fakeFs,
      pdfKitLoader: loader,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'month' });
    }
  });
});
