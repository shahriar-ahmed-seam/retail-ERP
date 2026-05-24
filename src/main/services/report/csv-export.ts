// src/main/services/report/csv-export.ts
//
// Streaming CSV report export (Phase 10, task 10.5).
//
// Pumps rows through the shared cursor pump (`./pump.ts`) and writes
// each batch through `papaparse.unparse` into a Node `WriteStream`.
// The header is emitted on the first batch only — subsequent batches
// are appended without their own header line — and the writer
// resolves only after the stream's `finish` event so the IPC handler
// knows the file is fully on disk before reporting completion.
//
// Memory bound: at most `pageSize` rows (200 by default) are
// resident at any one time. Each batch is converted to a CSV chunk,
// written to the stream, then released for GC. This is what keeps
// the 1M-row dataset case in Req 16.6 inside the 200 MB process
// budget (Property 17 / Req 16.6).
//
// Validates: Requirements 9.5, 16.3, 16.6.

import { unparse } from 'papaparse';

import { Err, Ok, type Result } from '@shared/result.js';

import {
  describeReport,
  pumpRows,
  type BatchConsumer,
  type ExportRow,
} from './pump.js';

import type { ReportExportRequest } from '@shared/dto/index.js';
import type { WriteStream as FsWriteStream } from 'node:fs';

// ---------------------------------------------------------------------------
// Filesystem injection seam
// ---------------------------------------------------------------------------

/**
 * Minimal slice of `fs` the CSV exporter uses. Declared structurally
 * so unit tests inject a recording stub without monkey-patching the
 * global module. Production wires to `node:fs`.
 */
export interface FsLike {
  createWriteStream(path: string): FsWriteStream;
}

/**
 * Default `fs` loader. Lazy `require` so unit tests substituting a
 * stub never load the real module.
 */
function defaultFs(): FsLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return { createWriteStream: fs.createWriteStream };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Options for {@link exportCsv}.
 *
 * `request` selects the report and forwards filter / sort. `path` is
 * the absolute output filename — chosen by the renderer via
 * `dialog.showSaveDialog` and forwarded through the IPC handler.
 * `fs` and `pageSize` are test seams; production callers leave them
 * default.
 */
export interface CsvExportOptions {
  readonly request: ReportExportRequest;
  readonly path: string;
  readonly fs?: FsLike;
  readonly pageSize?: number;
}

/**
 * CSV export result. Mirrors the `reports:export` response shape
 * for the single-format case. The IPC handler builds the wire-format
 * envelope (`{ csvPath, pdfPath?, rowCount }`) on top of this.
 */
export interface CsvExportResult {
  readonly path: string;
  readonly rowCount: number;
}

/**
 * Stream `request`'s rows into a CSV file at `path`.
 *
 * Steps:
 *
 *   1. Open `fs.createWriteStream(path)`. Errors during open are
 *      reported as `Err('INTERNAL', { reason: 'io', cause })`.
 *   2. Drive `pumpRows` over the report's cursor; for each batch:
 *      - Render with `papaparse.unparse(batch, { header: i === 0,
 *        newline: '\n' })` so the header appears once on the first
 *        batch only.
 *      - Append a trailing `'\n'` so subsequent appended chunks
 *        start on their own line.
 *      - Honor `stream.write` backpressure with a `'drain'` await so
 *        the pump cannot race ahead of the disk.
 *   3. After the pump returns, call `stream.end()` and resolve only
 *      after the writable's `'finish'` event — at that point the
 *      file is fully flushed and on disk.
 *
 * Resolves with `Ok({ path, rowCount })` on success or an `Err`
 * envelope on failure (validation from the pump, I/O from the
 * stream). On a stream error mid-write the stream is destroyed and
 * the partial file is left in place — the operator can clean it up;
 * doing the cleanup here would race with the `finish`/`error`
 * settle.
 */
export async function exportCsv(
  options: CsvExportOptions,
): Promise<Result<CsvExportResult>> {
  const fs = options.fs ?? defaultFs();
  const { request, path, pageSize } = options;

  // The shape lookup also serves as a runtime guard against an
  // unknown reportId — `describeReport` throws on a bad id, which
  // we map to a clean VALIDATION envelope.
  let columns: readonly { readonly key: string; readonly header: string }[];
  try {
    columns = describeReport(request.reportId).columns;
  } catch {
    return Err('VALIDATION', { field: 'reportId' });
  }

  let stream: FsWriteStream;
  try {
    stream = fs.createWriteStream(path);
  } catch (err) {
    return Err('INTERNAL', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  // Capture stream errors that can fire either before or after the
  // pump finishes. Settled exactly once via `streamSettle`.
  let streamError: Error | null = null;
  const errorListener = (err: Error): void => {
    streamError = err;
  };
  stream.on('error', errorListener);

  // Per-batch consumer: render with papaparse, then write and honor
  // backpressure. Every encoder MUST keep at most one batch's worth
  // of bytes in memory at any point.
  const consumer: BatchConsumer<ExportRow> = async (batch, meta) => {
    if (streamError !== null) {
      throw streamError;
    }
    const chunk = renderBatch(batch, columns, meta.batchIndex === 0);
    if (chunk.length === 0) {
      return;
    }
    const ok = stream.write(chunk);
    if (!ok) {
      await new Promise<void>((resolve) => {
        stream.once('drain', resolve);
      });
    }
  };

  // Drive the pump. Any pump-level Err propagates straight out; we
  // close the stream first to release the file handle.
  let pumpResult: Result<{ rowCount: number }>;
  try {
    pumpResult = await pumpRows(
      pageSize !== undefined ? { request, pageSize } : { request },
      consumer,
    );
  } catch (err) {
    stream.destroy();
    return Err('INTERNAL', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (!pumpResult.ok) {
    stream.destroy();
    return pumpResult;
  }

  // Close the stream and wait for `finish`. Stream-level errors
  // surfaced before `finish` are mapped to INTERNAL; we keep the
  // partial file in place because deleting it would race against
  // `finish` on platforms where the file handle is still open.
  return new Promise<Result<CsvExportResult>>((resolve) => {
    let settled = false;
    const settle = (result: Result<CsvExportResult>): void => {
      if (settled) return;
      settled = true;
      stream.removeListener('error', errorListener);
      resolve(result);
    };

    stream.once('finish', () => {
      if (streamError !== null) {
        settle(
          Err('INTERNAL', {
            reason: 'io',
            cause: streamError.message,
          }),
        );
        return;
      }
      settle(Ok({ path, rowCount: pumpResult.ok ? pumpResult.value.rowCount : 0 }));
    });
    stream.once('error', (err: Error) => {
      settle(Err('INTERNAL', { reason: 'io', cause: err.message }));
    });
    stream.end();
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Render one batch of rows as a CSV chunk. The header is emitted on
 * the first batch only (`emitHeader === true`); subsequent batches
 * skip the header.
 *
 * `papaparse.unparse` accepts an `{ fields, data }` object form
 * which is the convention for explicit column ordering — both
 * encoders share the same `ExportColumn[]` declaration so the
 * column order matches the PDF rendering exactly.
 *
 * The trailing newline is appended unconditionally so the next
 * batch's first row does not concatenate with the previous batch's
 * last row.
 */
function renderBatch(
  batch: readonly ExportRow[],
  columns: readonly { readonly key: string; readonly header: string }[],
  emitHeader: boolean,
): string {
  if (batch.length === 0 && !emitHeader) {
    return '';
  }
  // papaparse expects mutable string arrays; copy out the keys/headers.
  const fields = columns.map((c) => c.key);
  const headerRow = columns.map((c) => c.header);

  // Project each row into an array aligned with `fields`. Doing the
  // projection ourselves (rather than letting papaparse walk
  // arbitrary keys) guarantees a stable column order even if a row
  // omits some optional field.
  const data: string[][] = batch.map((row) =>
    fields.map((key) => stringifyCell((row as unknown as Record<string, unknown>)[key])),
  );

  if (emitHeader) {
    // Push the header as the first data row; passing `header: false`
    // to papaparse treats every entry uniformly.
    data.unshift(headerRow);
  }

  const csv = unparse(data, {
    header: false,
    newline: '\n',
    quotes: false,
  });
  return csv.length > 0 ? `${csv}\n` : '';
}

/** Coerce arbitrary cell values to strings. Numeric types are
 *  rendered via `String(...)`; `null`/`undefined` collapse to the
 *  empty string. */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Object / array / function: stringify via JSON so we don't end up
  // with the Object.prototype.toString fallback ('[object Object]').
  // The cell shape is always primitive in production — every export
  // row's columns are explicit DTO fields — so this is a defensive
  // path for unexpected payloads only.
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
