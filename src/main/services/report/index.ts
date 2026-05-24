// src/main/services/report/index.ts
//
// Barrel + combined-export entry point for the streaming report
// exporter (Phase 10, tasks 10.5–10.7).
//
// The handler-facing surface is `exportReport(request, paths)`,
// which:
//
//   1. Opens 0–2 file write streams (one per requested format) plus
//      the matching encoder pipelines.
//   2. Drives the underlying SELECT exactly once via `pumpRows`,
//      regardless of whether one or both formats are requested.
//   3. Forwards each batch into every active encoder so the row
//      buffer is shared and disposed per batch — doubling the
//      output formats does NOT double the memory footprint
//      (Property 17 / Req 16.6).
//   4. Awaits every encoder's `finish` event before resolving with
//      `{ path, rowCount }` (single format) or `{ csvPath, pdfPath,
//      rowCount }` (both formats).
//
// The single-format helpers (`exportCsv`, `exportPdf`) live in
// dedicated modules and are exported here too; they each open their
// own pump for callers that explicitly need a single format. The
// combined entry point is what the IPC handler wires
// `reports:export` to.

export { exportCsv } from './csv-export.js';
export type { CsvExportOptions, CsvExportResult, FsLike as CsvFsLike } from './csv-export.js';

export { exportPdf } from './pdf-export.js';
export type {
  PdfExportOptions,
  PdfExportResult,
  FsLike as PdfFsLike,
  PdfDocLike,
  PdfKitLike,
  PdfKitLoader,
} from './pdf-export.js';

export {
  describeReport,
  pumpRows,
  DEFAULT_PAGE_SIZE,
  SALES_EXPORT_COLUMNS,
  LOW_STOCK_EXPORT_COLUMNS,
  TOP_SELLING_EXPORT_COLUMNS,
} from './pump.js';
export type {
  BatchConsumer,
  ExportColumn,
  ExportRow,
  PumpOptions,
  ReportShape,
  SalesExportRow,
} from './pump.js';

import { unparse } from 'papaparse';

import { Err, Ok, type Result } from '@shared/result.js';

import {
  describeReport,
  pumpRows,
  type BatchConsumer,
  type ExportColumn,
  type ExportRow,
} from './pump.js';

import type { FsLike as CsvFsLike } from './csv-export.js';
import type { FsLike as PdfFsLike, PdfKitLoader } from './pdf-export.js';
import type {
  ReportExportFormat,
  ReportExportRequest,
  ReportExportResponse,
} from '@shared/dto/index.js';
import type { WriteStream as FsWriteStream } from 'node:fs';

// ---------------------------------------------------------------------------
// exportReport — combined entry point
// ---------------------------------------------------------------------------

/**
 * Options for {@link exportReport}.
 *
 * `paths` carries one absolute output filename per requested format.
 * Either `csv`, `pdf`, or both must be present; the requested set is
 * derived from the keys present here. Tests inject `fs` /
 * `pdfKitLoader` to substitute in-memory recorders; production
 * callers leave them default.
 */
export interface ExportReportOptions {
  readonly request: ReportExportRequest;
  readonly paths: { readonly csv?: string; readonly pdf?: string };
  readonly fs?: CsvFsLike & PdfFsLike;
  readonly pdfKitLoader?: PdfKitLoader;
  readonly pageSize?: number;
}

/**
 * Drive the report's cursor pump exactly once and feed each batch
 * into every requested encoder. Returns once every encoder's
 * `finish` event has fired.
 */
export async function exportReport(
  options: ExportReportOptions,
): Promise<Result<ReportExportResponse>> {
  const { request, paths, pageSize } = options;
  const formats: ReportExportFormat[] = [];
  if (typeof paths.csv === 'string') formats.push('csv');
  if (typeof paths.pdf === 'string') formats.push('pdf');
  if (formats.length === 0) {
    return Err('VALIDATION', { field: 'paths' });
  }

  // Validate the report id up front so we surface a clean envelope
  // before opening any stream.
  let shape: { readonly title: string; readonly columns: readonly ExportColumn<ExportRow>[] };
  try {
    shape = describeReport(request.reportId);
  } catch {
    return Err('VALIDATION', { field: 'reportId' });
  }

  const fs = options.fs ?? defaultFs();
  const pdfKitLoader = options.pdfKitLoader ?? defaultPdfKitLoader;

  // Allocate per-format encoders. Each encoder owns its own write
  // stream and exposes a `consume(batch, meta)` callback the shared
  // pump invokes per batch. On any setup failure we tear down
  // already-opened encoders so we do not leak file handles.
  let csvEncoder: CsvEncoder | null = null;
  let pdfEncoder: PdfEncoder | null = null;
  try {
    if (typeof paths.csv === 'string') {
      csvEncoder = openCsvEncoder(paths.csv, shape.columns, fs);
    }
    if (typeof paths.pdf === 'string') {
      pdfEncoder = openPdfEncoder(paths.pdf, shape.title, shape.columns, fs, pdfKitLoader);
    }
  } catch (err) {
    csvEncoder?.destroy();
    pdfEncoder?.destroy();
    return Err('INTERNAL', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  // Single shared consumer — every batch is forwarded into every
  // active encoder before the next page is fetched. Backpressure on
  // either encoder propagates back to the pump because the
  // encoder.consume promises resolve only after their `drain`
  // events fire.
  const consumer: BatchConsumer<ExportRow> = async (batch, meta) => {
    if (csvEncoder !== null) {
      await csvEncoder.consume(batch, meta);
    }
    if (pdfEncoder !== null) {
      await pdfEncoder.consume(batch, meta);
    }
  };

  // Drive the pump.
  let pumpResult: Result<{ rowCount: number }>;
  try {
    pumpResult = await pumpRows(
      pageSize !== undefined ? { request, pageSize } : { request },
      consumer,
    );
  } catch (err) {
    csvEncoder?.destroy();
    pdfEncoder?.destroy();
    return Err('INTERNAL', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (!pumpResult.ok) {
    csvEncoder?.destroy();
    pdfEncoder?.destroy();
    return pumpResult;
  }

  // Finalize every encoder in parallel so the wall-clock cost of
  // waiting for two `finish` events is the max, not the sum.
  const finishResults = await Promise.all(
    [
      csvEncoder !== null ? csvEncoder.finalize() : null,
      pdfEncoder !== null ? pdfEncoder.finalize() : null,
    ].filter((p): p is Promise<Result<{ path: string }>> => p !== null),
  );

  for (const r of finishResults) {
    if (!r.ok) return r;
  }

  // Build the response envelope based on which formats were
  // requested. Single format → `{ path, rowCount }`; both formats →
  // `{ csvPath, pdfPath, rowCount }`.
  const rowCount = pumpResult.value.rowCount;
  if (formats.length === 1) {
    const single = formats[0];
    const path = single === 'csv' ? paths.csv : paths.pdf;
    if (typeof path !== 'string') {
      // Defensive — formats are derived from path presence above.
      return Err('VALIDATION', { field: 'paths' });
    }
    return Ok({ path, rowCount });
  }

  // Both formats requested.
  const csvPath = paths.csv;
  const pdfPath = paths.pdf;
  if (typeof csvPath !== 'string' || typeof pdfPath !== 'string') {
    return Err('VALIDATION', { field: 'paths' });
  }
  return Ok({ csvPath, pdfPath, rowCount });
}

// ---------------------------------------------------------------------------
// Internal CSV encoder
// ---------------------------------------------------------------------------

interface CsvEncoder {
  consume: BatchConsumer<ExportRow>;
  finalize: () => Promise<Result<{ path: string }>>;
  destroy: () => void;
}

function openCsvEncoder(
  path: string,
  columns: readonly ExportColumn<ExportRow>[],
  fs: CsvFsLike,
): CsvEncoder {
  const stream = fs.createWriteStream(path);
  let streamError: Error | null = null;
  stream.on('error', (err: Error) => {
    streamError = err;
  });

  const fields = columns.map((c) => c.key);
  const headers = columns.map((c) => c.header);

  const consume: BatchConsumer<ExportRow> = async (batch, meta) => {
    if (streamError !== null) throw streamError;
    if (batch.length === 0 && !meta.batchIndex) {
      // First-batch-but-empty: still emit header so the file is
      // self-describing.
      const headerOnly = unparse([headers], { header: false, newline: '\n' });
      if (headerOnly.length > 0) {
        await writeWithBackpressure(stream, `${headerOnly}\n`);
      }
      return;
    }
    if (batch.length === 0) return;

    const data: string[][] = batch.map((row) =>
      fields.map((key) => stringifyCell((row as unknown as Record<string, unknown>)[key])),
    );
    if (meta.batchIndex === 0) {
      data.unshift(headers);
    }
    const csv = unparse(data, { header: false, newline: '\n', quotes: false });
    if (csv.length === 0) return;
    await writeWithBackpressure(stream, `${csv}\n`);
  };

  const finalize = (): Promise<Result<{ path: string }>> =>
    new Promise<Result<{ path: string }>>((resolve) => {
      let settled = false;
      const settle = (r: Result<{ path: string }>): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      stream.once('finish', () => {
        if (streamError !== null) {
          settle(Err('INTERNAL', { reason: 'io', cause: streamError.message }));
          return;
        }
        settle(Ok({ path }));
      });
      stream.once('error', (err: Error) => {
        settle(Err('INTERNAL', { reason: 'io', cause: err.message }));
      });
      stream.end();
    });

  const destroy = (): void => {
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
  };

  return { consume, finalize, destroy };
}

// ---------------------------------------------------------------------------
// Internal PDF encoder
// ---------------------------------------------------------------------------

interface PdfEncoder {
  consume: BatchConsumer<ExportRow>;
  finalize: () => Promise<Result<{ path: string }>>;
  destroy: () => void;
}

const PDF_FONT_TITLE = 14;
const PDF_FONT_HEADER = 10;
const PDF_FONT_BODY = 9;
const PDF_ROW_HEIGHT = 14;

function openPdfEncoder(
  path: string,
  title: string,
  columns: readonly ExportColumn<ExportRow>[],
  fs: PdfFsLike,
  pdfKitLoader: PdfKitLoader,
): PdfEncoder {
  const stream = fs.createWriteStream(path);
  const PDFDocument = pdfKitLoader();
  // Minimal subset of the doc surface we actually need; satisfied by
  // both `pdfkit` and the unit-test stub.
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  doc.pipe(stream);

  let docError: Error | null = null;
  doc.on('error', (err: Error) => {
    docError = err;
  });

  // Initial title + header.
  doc.font('Helvetica-Bold').fontSize(PDF_FONT_TITLE).text(title, { align: 'center' });
  doc.moveDown(0.5);
  renderHeader(doc, columns);

  const consume: BatchConsumer<ExportRow> = (batch) => {
    if (docError !== null) {
      return Promise.reject(docError);
    }
    for (const row of batch) {
      const usableBottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + PDF_ROW_HEIGHT > usableBottom) {
        doc.addPage();
        renderHeader(doc, columns);
      }
      doc.font('Helvetica').fontSize(PDF_FONT_BODY);
      const cells = columns.map((c) =>
        stringifyCell((row as unknown as Record<string, unknown>)[c.key]),
      );
      doc.text(cells.join('  |  '));
    }
    return Promise.resolve();
  };

  const finalize = (): Promise<Result<{ path: string }>> =>
    new Promise<Result<{ path: string }>>((resolve) => {
      let settled = false;
      const settle = (r: Result<{ path: string }>): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      stream.once('finish', () => {
        if (docError !== null) {
          settle(Err('INTERNAL', { reason: 'io', cause: docError.message }));
          return;
        }
        settle(Ok({ path }));
      });
      stream.once('error', (err: Error) => {
        settle(Err('INTERNAL', { reason: 'io', cause: err.message }));
      });
      try {
        doc.end();
      } catch (err) {
        settle(
          Err('INTERNAL', {
            reason: 'io',
            cause: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    });

  const destroy = (): void => {
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
  };

  return { consume, finalize, destroy };
}

function renderHeader(
  doc: import('./pdf-export.js').PdfDocLike,
  columns: readonly ExportColumn<ExportRow>[],
): void {
  doc.font('Helvetica-Bold').fontSize(PDF_FONT_HEADER);
  doc.text(columns.map((c) => c.header).join('  |  '));
  doc.moveDown(0.2);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function writeWithBackpressure(stream: FsWriteStream, chunk: string): Promise<void> {
  const ok = stream.write(chunk);
  if (ok) return Promise.resolve();
  return new Promise<void>((resolve) => {
    stream.once('drain', resolve);
  });
}

function defaultFs(): CsvFsLike & PdfFsLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return { createWriteStream: fs.createWriteStream };
}

function defaultPdfKitLoader(): import('./pdf-export.js').PdfKitLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pdfkit') as import('./pdf-export.js').PdfKitLike;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
