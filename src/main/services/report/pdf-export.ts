// src/main/services/report/pdf-export.ts
//
// Streaming PDF report export (Phase 10, task 10.6).
//
// Pumps rows through the shared cursor pump (`./pump.ts`) and writes
// each batch into a `pdfkit` `PDFDocument` piped to a Node
// `WriteStream`. The library flushes finished pages to the stream as
// `addPage()` is called, so memory does not grow with row count
// (Property 17 / Req 16.6).
//
// Layout strategy: each page carries the report title + a column
// header row, then as many data rows as fit before `y` exceeds the
// usable page height. When that boundary is crossed we call
// `addPage()` and re-emit the header on the new page so the
// document is readable when printed. The library buffers exactly
// one page at a time.
//
// We resolve the export only after the writable stream's `finish`
// event fires so the IPC handler can return a path that is fully on
// disk.
//
// Validates: Requirements 9.5, 16.3, 16.6.

import { Err, Ok, type Result } from '@shared/result.js';

import {
  describeReport,
  pumpRows,
  type BatchConsumer,
  type ExportRow,
  type ExportColumn,
} from './pump.js';

import type { ReportExportRequest } from '@shared/dto/index.js';
import type { WriteStream as FsWriteStream } from 'node:fs';

// ---------------------------------------------------------------------------
// Filesystem + pdfkit injection seams
// ---------------------------------------------------------------------------

/** Minimal slice of `fs` the exporter uses. */
export interface FsLike {
  createWriteStream(path: string): FsWriteStream;
}

/** Minimal slice of pdfkit's PDFDocument. */
export interface PdfDocLike {
  pipe(stream: FsWriteStream): PdfDocLike;
  font(name: string): PdfDocLike;
  fontSize(size: number): PdfDocLike;
  text(value: string, options?: { align?: 'left' | 'center' | 'right' }): PdfDocLike;
  moveDown(lines?: number): PdfDocLike;
  addPage(): PdfDocLike;
  end(): void;
  on(event: 'finish', listener: () => void): PdfDocLike;
  on(event: 'error', listener: (err: Error) => void): PdfDocLike;
  /** y-coordinate of the next text write. Used by the row pump to
   *  decide when to call `addPage()`. */
  readonly y: number;
  readonly page: { readonly height: number; readonly margins: { readonly bottom: number } };
}

/** PDFDocument constructor signature, narrowed to the fields we use. */
export type PdfKitLike = new (init?: { size?: 'A4' | 'LETTER'; margin?: number }) => PdfDocLike;

/** Loader for the pdfkit module. */
export type PdfKitLoader = () => PdfKitLike;

function defaultFs(): FsLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return { createWriteStream: fs.createWriteStream };
}

function defaultPdfKitLoader(): PdfKitLike {
  // pdfkit is CommonJS; the default export IS the PDFDocument
  // constructor. Lazy require so unit tests injecting a stub do not
  // load the real library.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pdfkit') as PdfKitLike;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Options for {@link exportPdf}.
 *
 * `request` selects the report and forwards filter / sort. `path` is
 * the absolute output filename — chosen by the renderer via
 * `dialog.showSaveDialog` and forwarded through the IPC handler.
 * `title` overrides the document heading; defaults to
 * `describeReport(reportId).title`. `fs`, `pdfKitLoader`, and
 * `pageSize` are test seams.
 */
export interface PdfExportOptions {
  readonly request: ReportExportRequest;
  readonly path: string;
  readonly title?: string;
  readonly fs?: FsLike;
  readonly pdfKitLoader?: PdfKitLoader;
  readonly pageSize?: number;
}

export interface PdfExportResult {
  readonly path: string;
  readonly rowCount: number;
}

/** Layout constants — A4 page, 36pt margin, 10pt body font. */
const FONT_SIZE_TITLE = 14;
const FONT_SIZE_HEADER = 10;
const FONT_SIZE_BODY = 9;
const ROW_HEIGHT = 14; // pt; matches body font line height + small padding.

/**
 * Stream `request`'s rows into a PDF file at `path`.
 *
 * Pipeline:
 *
 *   1. Open `fs.createWriteStream(path)` and a fresh `PDFDocument`
 *      piped into it.
 *   2. Render the title + first-page column header.
 *   3. Drive `pumpRows` over the report's cursor; for each batch:
 *      - For each row, check `doc.y` against the usable page height.
 *        If a row would overflow, call `doc.addPage()` and re-emit
 *        the column header on the new page.
 *      - Render the row's columns by reading values via the same
 *        `ExportColumn` declarations the CSV encoder uses, so both
 *        formats produce identical column orders.
 *   4. After the pump returns, call `doc.end()` and resolve only
 *      after the writable's `'finish'` event.
 *
 * Resolves with `Ok({ path, rowCount })` on success or an `Err`
 * envelope on failure.
 */
export async function exportPdf(
  options: PdfExportOptions,
): Promise<Result<PdfExportResult>> {
  const fs = options.fs ?? defaultFs();
  const pdfKitLoader = options.pdfKitLoader ?? defaultPdfKitLoader;
  const { request, path, pageSize } = options;

  // Validate the report id up front so we map a malformed request
  // to a clean envelope rather than throwing in the consumer.
  let shape: { readonly title: string; readonly columns: readonly ExportColumn<ExportRow>[] };
  try {
    shape = describeReport(request.reportId);
  } catch {
    return Err('VALIDATION', { field: 'reportId' });
  }
  const docTitle = options.title ?? shape.title;

  let stream: FsWriteStream;
  try {
    stream = fs.createWriteStream(path);
  } catch (err) {
    return Err('INTERNAL', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  let doc: PdfDocLike;
  try {
    const PDFDocument = pdfKitLoader();
    doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc.pipe(stream);
  } catch (err) {
    stream.destroy();
    return Err('INTERNAL', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  // Capture pdfkit and stream errors. Both surfaces fire via the
  // standard `error` event; we settle exactly once.
  let docError: Error | null = null;
  const docErrorListener = (err: Error): void => {
    docError = err;
  };
  doc.on('error', docErrorListener);

  // ----- Render title + first-page column header ---------------------------
  doc.font('Helvetica-Bold').fontSize(FONT_SIZE_TITLE).text(docTitle, { align: 'center' });
  doc.moveDown(0.5);
  renderColumnHeader(doc, shape.columns);

  // Per-batch consumer: render each row, paginating as we go.
  const consumer: BatchConsumer<ExportRow> = (batch) => {
    if (docError !== null) {
      return Promise.reject(docError);
    }
    for (const row of batch) {
      // pdfkit auto-advances `y`; we paginate when the next write
      // would overflow the usable area. `doc.y` reflects the
      // current cursor; `page.height - margins.bottom` is the
      // usable bottom edge.
      const usableBottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + ROW_HEIGHT > usableBottom) {
        doc.addPage();
        renderColumnHeader(doc, shape.columns);
      }
      renderRow(doc, shape.columns, row);
    }
    return Promise.resolve();
  };

  // Drive the pump.
  let pumpResult: Result<{ rowCount: number }>;
  try {
    pumpResult = await pumpRows(
      pageSize !== undefined ? { request, pageSize } : { request },
      consumer,
    );
  } catch (err) {
    try {
      doc.end();
    } catch {
      /* ignore */
    }
    stream.destroy();
    return Err('INTERNAL', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (!pumpResult.ok) {
    try {
      doc.end();
    } catch {
      /* ignore */
    }
    stream.destroy();
    return pumpResult;
  }

  // Close the document and wait for the writable's `finish` event.
  return new Promise<Result<PdfExportResult>>((resolve) => {
    let settled = false;
    const settle = (result: Result<PdfExportResult>): void => {
      if (settled) return;
      settled = true;
      doc.on('error', () => {
        /* drop late errors */
      });
      resolve(result);
    };

    stream.once('finish', () => {
      if (docError !== null) {
        settle(
          Err('INTERNAL', {
            reason: 'io',
            cause: docError.message,
          }),
        );
        return;
      }
      settle(Ok({ path, rowCount: pumpResult.ok ? pumpResult.value.rowCount : 0 }));
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
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderColumnHeader(
  doc: PdfDocLike,
  columns: readonly ExportColumn<ExportRow>[],
): void {
  doc.font('Helvetica-Bold').fontSize(FONT_SIZE_HEADER);
  doc.text(columns.map((c) => c.header).join('  |  '));
  doc.moveDown(0.2);
}

function renderRow(
  doc: PdfDocLike,
  columns: readonly ExportColumn<ExportRow>[],
  row: ExportRow,
): void {
  doc.font('Helvetica').fontSize(FONT_SIZE_BODY);
  const cells = columns.map((c) => stringifyCell((row as unknown as Record<string, unknown>)[c.key]));
  doc.text(cells.join('  |  '));
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
