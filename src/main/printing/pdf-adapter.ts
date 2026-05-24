// src/main/printing/pdf-adapter.ts
//
// PDF printer adapter (Phase 8, task 8.4) — the LAST-RESORT link in
// the receipt printer chain (design.md > "Receipt Printing
// Pipeline"). Used when ESC/POS and HTML adapters both fall
// through. Writes a PDF document to disk under `<userData>/receipts`,
// named after the sale's serial number, so the operator can locate
// and re-print the receipt later.
//
// Why "last resort":
//
//   - Filesystem writes are far more reliable than network/USB
//     printers — paper jams, USB enumeration races, and Electron
//     print bugs all sit upstream of `fs.createWriteStream`.
//   - The PDF can be re-printed from any other workflow (system
//     viewer, attached email, courier slip).
//   - Writing always succeeds on a healthy disk, so the chain
//     terminates in a printed-or-saved state on every code path.
//
// The adapter therefore only returns `Err` on a TRUE I/O failure
// (out of disk, permission denied, target directory unwritable).
// Configuration errors do not exist here — there is nothing to
// configure.
//
// `app.getPath('userData')` is the canonical home for the PDF
// directory in production. When `app` is unavailable (Vitest, CI,
// any non-Electron host), the adapter falls back to `os.tmpdir()`
// + a stable subfolder so test runs do not leak `<userData>`
// resolution into the property/integration tiers. The fallback is
// OK for tests because the integration suite uses `os.tmpdir()` for
// everything else (per-test SQLite DB, see `tests/integration/
// fixtures/temp-db.ts`).
//
// `pdfkit` is invoked in streaming mode — `doc.pipe(fs.createWriteStream)`.
// Pages flush as the document grows, so memory stays bounded by
// pdfkit's internal page buffer (a single A6-ish page in our case).
// We resolve only after the writable stream's `finish` event so the
// caller knows the file is fully on disk before continuing.
//
// Validates: Requirement 4.8.

import { mkdirSync, type WriteStream as FsWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Err, Ok, type Result } from '@shared/result.js';

import type { PrinterAdapter, PrintResult } from '@main/printing/types.js';
import type {
  ReceiptDTO,
  ReceiptLine,
  ReceiptPayment,
} from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// File system + Electron interop — minimal slices the adapter touches
// ---------------------------------------------------------------------------

/**
 * Minimal slice of `fs` the adapter uses. Declared structurally so
 * unit tests can inject a recording stub without monkey-patching
 * the global module. Production wires to `node:fs`.
 */
export interface FsLike {
  createWriteStream(path: string): FsWriteStream;
}

/**
 * Loader for the `electron` module's `app.getPath`. Returns the
 * resolved `userData` directory, or `null` when Electron is not
 * available (test env, or pre-`app.ready` bootstrap).
 *
 * Production wraps `require('electron').app.getPath('userData')` in
 * a `try/catch`. Tests inject a recording stub.
 */
export type UserDataLoader = () => string | null;

/**
 * Loader for the pdfkit module. Returns the `PDFDocument`
 * constructor; tests inject a stub that records every method call
 * and writes a minimal `%PDF-` header so the on-disk file is
 * recognisable.
 */
export type PdfKitLoader = () => PdfKitLike;

/**
 * Minimal slice of pdfkit's PDFDocument the adapter calls. We use
 * the imperative-text API (`text`, `moveDown`, `font`, `fontSize`)
 * because the receipt is a single short page — no flow layout
 * needed.
 */
export interface PdfDocLike {
  pipe(stream: FsWriteStream): PdfDocLike;
  font(name: string): PdfDocLike;
  fontSize(size: number): PdfDocLike;
  text(value: string, options?: { align?: 'left' | 'center' | 'right' }): PdfDocLike;
  moveDown(lines?: number): PdfDocLike;
  end(): void;
  on(event: 'finish', listener: () => void): PdfDocLike;
  on(event: 'error', listener: (err: Error) => void): PdfDocLike;
}

/**
 * Constructor signature for `PDFDocument` — pdfkit uses a CommonJS
 * default export. Init options narrow to the fields the adapter
 * actually sets.
 */
export type PdfKitLike = new (init?: { size?: [number, number]; margin?: number }) => PdfDocLike;

// ---------------------------------------------------------------------------
// Default loaders
// ---------------------------------------------------------------------------

/**
 * Resolve the directory where receipts should be written. Prefers
 * `<userData>/receipts` when Electron's `app` is available;
 * otherwise falls back to `<os.tmpdir()>/core-retail-erp-receipts`
 * so test runs and headless CLI tooling continue to function
 * without an Electron host.
 */
function defaultUserDataLoader(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const candidate = require('electron') as unknown;
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      'app' in candidate
    ) {
      const app = (candidate as { app: { getPath?: (name: string) => string } }).app;
      if (typeof app.getPath === 'function') {
        const path = app.getPath('userData');
        if (typeof path === 'string' && path.length > 0) {
          return path;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function defaultPdfKitLoader(): PdfKitLike {
  // `pdfkit` is CommonJS; the default export IS the PDFDocument
  // constructor. We import lazily so unit tests injecting a stub
  // never load the full library.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pdfkit') as PdfKitLike;
}

function defaultFs(): FsLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return { createWriteStream: fs.createWriteStream };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Produce the absolute output path `<receiptsDir>/<serialNo>.pdf`.
 * Creates `<receiptsDir>` recursively when missing — `mkdirSync`
 * with `recursive: true` is idempotent and silences EEXIST.
 *
 * The serial number is sanitized to a filesystem-safe form by
 * stripping anything outside `[A-Za-z0-9._-]`. In practice the
 * serial is always `INV-XXXXXX` which already passes the filter,
 * but the sanitization is defensive against a future serial-format
 * change that introduced spaces or punctuation.
 */
function resolveReceiptPath(baseDir: string, serialNo: string): string {
  const safeSerial = serialNo.replace(/[^A-Za-z0-9._-]/g, '_');
  const receiptsDir = join(baseDir, 'receipts');
  mkdirSync(receiptsDir, { recursive: true });
  return join(receiptsDir, `${safeSerial}.pdf`);
}

// ---------------------------------------------------------------------------
// Receipt rendering
// ---------------------------------------------------------------------------

/**
 * 80mm × 297mm (A6 height) page sized in PostScript points (1pt =
 * 1/72in). 80mm ≈ 226.8pt, 297mm ≈ 841.9pt. Constants kept inline
 * so the file is self-contained.
 */
const PAGE_WIDTH_PT = 226.8;
const PAGE_HEIGHT_PT = 841.9;
const PAGE_MARGIN_PT = 12;

/**
 * Append every section of the receipt to the PDF document. The
 * order mirrors the ESC/POS and HTML adapters one-to-one so the PDF
 * fallback looks structurally identical to a thermal-printed
 * receipt:
 *
 *   1. Centered shop-info header (name in bold, optional address /
 *      phone / tax id).
 *   2. Sale meta (serial, ISO timestamp, cashier, optional
 *      customer).
 *   3. Item table — name on the left, line total on the right
 *      (rendered as two columns via right-aligned text).
 *   4. Totals block (subtotal, discount, tax, grand total).
 *   5. Payments block — one row per payment.
 *   6. Centered footer with the serial number.
 *
 * No formatting on the decimal values — every string flows through
 * verbatim from the persisted `Sale` row.
 */
function renderReceiptToPdf(doc: PdfDocLike, receipt: ReceiptDTO): void {
  // ----- 1. Header --------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(11).text(receipt.shopInfo.name, { align: 'center' });
  doc.font('Helvetica').fontSize(9);
  if (receipt.shopInfo.address !== null) {
    doc.text(receipt.shopInfo.address, { align: 'center' });
  }
  if (receipt.shopInfo.phone !== null) {
    doc.text(`Tel: ${receipt.shopInfo.phone}`, { align: 'center' });
  }
  if (receipt.shopInfo.taxId !== null) {
    doc.text(`Tax ID: ${receipt.shopInfo.taxId}`, { align: 'center' });
  }
  doc.moveDown(0.5);

  // ----- 2. Sale meta -----------------------------------------------------
  doc.fontSize(9);
  doc.text(`Receipt: ${receipt.serialNo}`);
  doc.text(`Date: ${receipt.createdAt}`);
  doc.text(`Cashier: ${receipt.cashierName}`);
  if (receipt.customerName !== null) {
    doc.text(`Customer: ${receipt.customerName}`);
  }
  doc.moveDown(0.5);

  // ----- 3. Items ---------------------------------------------------------
  for (const line of receipt.lines) {
    appendItemPdf(doc, line);
  }
  doc.moveDown(0.3);

  // ----- 4. Totals --------------------------------------------------------
  appendTotalRow(doc, 'Subtotal', receipt.subtotal);
  appendTotalRow(doc, 'Discount', receipt.discount);
  appendTotalRow(doc, 'Tax', receipt.taxTotal);
  doc.font('Helvetica-Bold');
  appendTotalRow(doc, 'Grand Total', receipt.grandTotal);
  doc.font('Helvetica');
  doc.moveDown(0.3);

  // ----- 5. Payments ------------------------------------------------------
  for (const payment of receipt.payments) {
    appendPaymentPdf(doc, payment);
  }
  doc.moveDown(0.3);

  // ----- 6. Footer --------------------------------------------------------
  doc.text(receipt.serialNo, { align: 'center' });
}

/**
 * Render a single line item: the name + line total stacked on top
 * of a `qty × unit` detail row. Mirrors the ESC/POS adapter.
 *
 * pdfkit does not have a native two-column row primitive at the
 * imperative-text API level, so we render the row as a single
 * left-then-right concatenation. The receipt is short and the
 * monospace font is wide enough that visual alignment is good
 * enough for an end-customer's till tape; the operator can always
 * re-print on a thermal printer when one becomes available.
 */
function appendItemPdf(doc: PdfDocLike, line: ReceiptLine): void {
  doc.text(`${line.name}    ${line.lineTotal}`);
  doc.text(`  ${line.quantity} x ${line.unitPrice}`);
}

/**
 * Render a totals row. The label and value are concatenated with
 * sufficient horizontal whitespace to read as two columns at the
 * narrow page width.
 */
function appendTotalRow(doc: PdfDocLike, label: string, value: string): void {
  doc.text(`${label}    ${value}`, { align: 'right' });
}

/**
 * Render a single payment row. Method label uppercased to match the
 * ESC/POS and HTML adapters.
 */
function appendPaymentPdf(doc: PdfDocLike, payment: ReceiptPayment): void {
  const label = payment.method.toUpperCase();
  doc.text(`${label}    ${payment.amount}`, { align: 'right' });
}

// ---------------------------------------------------------------------------
// print
// ---------------------------------------------------------------------------

/**
 * Options for the PDF adapter's `print`. Defaults wire to the
 * production loaders; tests inject stubs.
 */
export interface PdfPrintOptions {
  readonly userDataLoader?: UserDataLoader;
  readonly pdfKitLoader?: PdfKitLoader;
  readonly fs?: FsLike;
  /** Override the base directory directly (skips the userData fallback chain). */
  readonly baseDir?: string;
}

/**
 * Render `receipt` to a PDF file at `<baseDir>/receipts/<serialNo>.pdf`.
 *
 * Steps:
 *   1. Resolve `baseDir`: explicit override → `app.getPath('userData')`
 *      → `os.tmpdir()`/core-retail-erp-receipts. The fallback chain
 *      means tests run without Electron and production runs with
 *      Electron seamlessly.
 *   2. Compute the receipt path and ensure the parent directory
 *      exists (`mkdirSync` with `recursive: true`, idempotent).
 *   3. Open a `fs.WriteStream`, pipe a fresh `PDFDocument` into
 *      it, render the receipt sections, and call `doc.end()`.
 *   4. Wait for the writable stream's `finish` event before
 *      resolving so the caller knows the file is fully on disk.
 *
 * Returns:
 *   - `Ok({ adapter: 'pdf', output: path })` once the file is on
 *     disk.
 *   - `Err({ reason: 'io', cause })` only on a true filesystem
 *     failure (mkdir EACCES, ENOSPC, write stream error).
 */
export async function print(
  receipt: ReceiptDTO,
  options: PdfPrintOptions = {},
): Promise<Result<PrintResult>> {
  const userDataLoader = options.userDataLoader ?? defaultUserDataLoader;
  const pdfKitLoader = options.pdfKitLoader ?? defaultPdfKitLoader;
  const fs = options.fs ?? defaultFs();

  // Resolve the base directory. Order: explicit override (tests),
  // Electron's userData (production), os.tmpdir() (fallback).
  const baseDir =
    options.baseDir ??
    userDataLoader() ??
    join(tmpdir(), 'core-retail-erp-receipts');

  let outputPath: string;
  try {
    outputPath = resolveReceiptPath(baseDir, receipt.serialNo);
  } catch (err) {
    return Err('PRINTER_FAILURE', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  return new Promise<Result<PrintResult>>((resolve) => {
    let stream: FsWriteStream;
    try {
      stream = fs.createWriteStream(outputPath);
    } catch (err) {
      resolve(
        Err('PRINTER_FAILURE', {
          reason: 'io',
          cause: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    let settled = false;
    const settle = (result: Result<PrintResult>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Stream-level errors (EACCES, ENOSPC) bubble up here. We
    // settle once and ignore subsequent events.
    stream.on('error', (err: Error) => {
      settle(
        Err('PRINTER_FAILURE', {
          reason: 'io',
          cause: err.message,
        }),
      );
    });
    stream.on('finish', () => {
      settle(Ok({ adapter: 'pdf', output: outputPath }));
    });

    try {
      const PDFDocument = pdfKitLoader();
      const doc = new PDFDocument({
        size: [PAGE_WIDTH_PT, PAGE_HEIGHT_PT],
        margin: PAGE_MARGIN_PT,
      });
      doc.pipe(stream);
      // pdfkit emits its own `error` events on document-level
      // failures (font load, stream backpressure). Forward them
      // to the same settle path.
      doc.on('error', (err: Error) => {
        settle(
          Err('PRINTER_FAILURE', {
            reason: 'io',
            cause: err.message,
          }),
        );
      });

      renderReceiptToPdf(doc, receipt);
      doc.end();
    } catch (err) {
      settle(
        Err('PRINTER_FAILURE', {
          reason: 'io',
          cause: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

/**
 * `PrinterAdapter` instance for the chain. Acts as the LAST link;
 * since it writes a local file it almost always succeeds, which is
 * what lets the chain "always terminate in a printed-or-saved
 * state" per design.md.
 */
export const pdfAdapter: PrinterAdapter = Object.freeze({
  name: 'pdf',
  print(receipt: ReceiptDTO): Promise<Result<PrintResult>> {
    return print(receipt);
  },
});
