// src/main/printing/types.ts
//
// Shared types for the receipt printer chain (Phase 8, tasks 8.2 / 8.3
// / 8.4 / 8.5).
//
// Three adapters implement `PrinterAdapter`:
//
//   - `escposAdapter` (`escpos-adapter.ts`)  — primary; talks to a
//     USB / serial / network ESC/POS thermal printer via the
//     `node-thermal-printer` library. Configured by the `Setting`
//     row keyed `printer.escpos` (`{ kind, target }`).
//
//   - `htmlAdapter` (`html-adapter.ts`)      — secondary fallback;
//     renders a hand-rolled 80mm HTML template into an offscreen
//     `BrowserWindow` and triggers `webContents.print({ silent:
//     true })`. The OS picks the system default printer.
//
//   - `pdfAdapter` (`pdf-adapter.ts`)        — last-resort fallback;
//     writes a `pdfkit` PDF to `<userData>/receipts/<serialNo>.pdf`.
//     This adapter never returns `Err` except on a true filesystem
//     failure (out of disk, permission denied), so the chain always
//     terminates in a printed-or-saved state.
//
// `ChainAdapter` (`printer.ts`) walks the adapters in order, calling
// each `print(receipt)` and accepting the first `Ok`. Any `Err` is
// treated as a fall-through signal — the chain moves on to the next
// adapter. If every adapter fails (vanishingly rare since PDF is a
// local file write), the chain returns the LAST adapter's `Err`
// envelope so the caller sees the most specific failure.
//
// Adapters MUST NOT throw — printer failures are post-commit and
// fire-and-forget; an unhandled exception would surface as an
// `unhandledRejection` and crash the main process. Every error path
// returns `Err('PRINTER_FAILURE', { reason, ... })` so the chain
// stays predictable and the unit tests can pattern-match on the
// reason discriminator.
//
// The `output` field on a successful `Ok` is the only side-channel
// the chain exposes: PDF returns the absolute filesystem path it
// wrote; ESC/POS and HTML return `undefined` (no observable output
// other than a printed page). Callers (the post-commit hook in
// `pos.service`) currently log the result and otherwise treat it as
// fire-and-forget.
//
// Validates: Requirements 4.7, 4.8, 4.9.

import type { ReceiptDTO } from '@shared/dto/index.js';
import type { Result } from '@shared/result.js';

// ---------------------------------------------------------------------------
// Adapter name discriminator
// ---------------------------------------------------------------------------

/**
 * Discriminator naming each concrete adapter. Surfaced on the
 * `Ok({ adapter })` envelope so the post-commit hook can log which
 * link in the chain handled a given receipt — useful when triaging a
 * "why did this print to PDF?" support ticket.
 */
export type PrinterAdapterName = 'escpos' | 'html' | 'pdf';

// ---------------------------------------------------------------------------
// PrintResult
// ---------------------------------------------------------------------------

/**
 * Successful payload returned by every adapter.
 *
 *   - `adapter` — which adapter handled the receipt (`'escpos' |
 *     'html' | 'pdf'`).
 *   - `output` — adapter-specific side-channel. The PDF adapter
 *     returns the absolute path of the written file so the caller
 *     can surface a "saved to ..." toast; ESC/POS and HTML omit the
 *     field (the side effect is a printed page). The field is
 *     declared as `output?: string` so callers compile cleanly under
 *     `exactOptionalPropertyTypes`.
 */
export interface PrintResult {
  readonly adapter: PrinterAdapterName;
  readonly output?: string;
}

// ---------------------------------------------------------------------------
// PrinterAdapter
// ---------------------------------------------------------------------------

/**
 * Common contract every adapter implements. The chain walks a static
 * list of adapters and calls `print` on each in order; the first
 * `Ok` wins. Adapters never throw — any thrown exception inside an
 * adapter is a bug.
 *
 * `print` is `async` because every concrete adapter does I/O
 * (network, USB, filesystem, Electron print dialog). Returning a
 * `Result` rather than throwing keeps the chain logic in
 * `printer.ts` straight-line — it just `if (!result.ok) continue` to
 * fall through.
 */
export interface PrinterAdapter {
  /** Stable name for logging + tests. */
  readonly name: PrinterAdapterName;
  /**
   * Render the receipt and return `Ok` on success or `Err` on any
   * recoverable failure. The chain treats every `Err` as a
   * fall-through signal; never throws.
   */
  print(receipt: ReceiptDTO): Promise<Result<PrintResult>>;
}

// ---------------------------------------------------------------------------
// Reason discriminators
// ---------------------------------------------------------------------------

/**
 * Stable string discriminators surfaced inside `Err('PRINTER_FAILURE',
 * { reason })` so the chain logic + unit tests can pattern-match on
 * the failure category without parsing free-text messages.
 *
 *   - `unconfigured`         — ESC/POS adapter has no `target` set
 *                              in `Setting('printer.escpos')`. The
 *                              chain falls through to HTML on this
 *                              code so a fresh install (target='')
 *                              still gets a receipt via the HTML or
 *                              PDF fallback.
 *   - `electron_unavailable` — HTML adapter could not load
 *                              `electron`'s `app` / `BrowserWindow`
 *                              module — typically because the
 *                              adapter is being exercised in the
 *                              Vitest environment. Treated as a
 *                              fall-through signal so test runs
 *                              never need an Electron context.
 *   - `io`                   — A real I/O failure (printer
 *                              disconnected, USB error, filesystem
 *                              permission denied, network timeout).
 *                              The `cause` field carries the
 *                              underlying error message for log
 *                              triage.
 *   - `invalid_config`       — The `Setting('printer.escpos')` row
 *                              held malformed JSON or an unknown
 *                              `kind` value. Treated identically to
 *                              `unconfigured` from the chain's
 *                              perspective (fall through), but
 *                              surfaces a distinct reason so the
 *                              operator can fix the row.
 */
export type PrinterFailureReason =
  | 'unconfigured'
  | 'electron_unavailable'
  | 'io'
  | 'invalid_config';
