// src/main/printing/printer.ts
//
// ChainAdapter, `selectPrinter`, `printReceipt`, and the post-commit
// print hook (Phase 8, task 8.5). This is the entry point the rest
// of the application uses; the three concrete adapters (ESC/POS,
// HTML, PDF) live behind it.
//
// Design contract (design.md > "Receipt Printing Pipeline" >
// "Adapter contract"):
//
//   ChainAdapter walks ESC/POS → HTML → PDF in order.
//   First success wins. PDF is the last-resort link and almost
//   always succeeds (it's a local file write), so the chain
//   terminates in a printed-or-saved state on every code path.
//
// `selectPrinter()` returns the chain. The function exists for
// symmetry with the design.md sketch and to keep the call site in
// `pos.service` short — `selectPrinter().print(receipt)` reads
// the way the design doc reads.
//
// `printReceipt(receipt)` is sugar for `selectPrinter().print(receipt)`.
// It's the function `postCommitPrint` calls; isolating it makes
// the chain unit-testable without going through the post-commit
// helper.
//
// `postCommitPrint(sale, prisma)` is the FIRE-AND-FORGET helper that
// `pos.service` calls AFTER the finalize transaction commits. It:
//
//   1. Loads the shop-info block via `loadShopInfoFromSettings` so
//      the receipt header carries the operator's brand (Req 4.7).
//   2. Builds the wire `ReceiptDTO` via `buildReceiptDTO`.
//   3. Calls `printReceipt` and discards the result on success.
//      Logs `Err` envelopes via `console.error` — the printer
//      chain's failure is informational, never fatal, because the
//      sale has already committed (Req 4.9, design.md > "Print
//      after commit").
//
// Critically, `postCommitPrint` NEVER throws and NEVER rejects with
// an unhandled error. The caller `void`s the returned promise so a
// jammed printer cannot back-pressure the POS UI or surface as an
// `unhandledRejection` in the main process.
//
// Test escape hatch: `process.env.SUPPRESS_RECEIPT_PRINTING === '1'`
// short-circuits the helper. Property and integration tests set
// this via their setup files so they don't write hundreds of tmp
// PDF files during a property-test session.
//
// Validates: Requirements 4.7, 4.8, 4.9.

import { prisma as defaultPrisma } from '@main/db/prisma.js';
import { escposAdapter } from '@main/printing/escpos-adapter.js';
import { htmlAdapter } from '@main/printing/html-adapter.js';
import { pdfAdapter } from '@main/printing/pdf-adapter.js';
import {
  buildReceiptDTO,
  loadShopInfoFromSettings,
  type PrismaLike as ReceiptPrismaLike,
} from '@main/printing/receipt-renderer.js';
import { Err, isOk } from '@shared/result.js';

import type {
  PrinterAdapter,
  PrintResult,
} from '@main/printing/types.js';
import type { ReceiptDTO, SaleDTO } from '@shared/dto/index.js';
import type {
  ErrorEnvelope,
  Result,
} from '@shared/result.js';


// ---------------------------------------------------------------------------
// ChainAdapter
// ---------------------------------------------------------------------------

/**
 * Walk a list of `PrinterAdapter`s in order, returning the first
 * `Ok`. On every `Err` the chain falls through to the next link.
 * If every adapter fails, the chain returns the LAST adapter's
 * `Err` envelope so the caller sees the most-specific failure.
 *
 * Exported as a free function because the chain has no per-instance
 * state — it's a fold over the adapters list.
 */
export async function runChain(
  adapters: readonly PrinterAdapter[],
  receipt: ReceiptDTO,
): Promise<Result<PrintResult>> {
  // Pre-condition: design hard-codes ESC/POS → HTML → PDF, so we
  // expect at least one adapter. Surface a clear `INTERNAL`-shaped
  // envelope on an empty list rather than returning a weird
  // "nothing happened" success.
  if (adapters.length === 0) {
    return Err('PRINTER_FAILURE', { reason: 'io', cause: 'no adapters configured' });
  }

  let lastErr: Result<PrintResult> | null = null;
  for (const adapter of adapters) {
    const result = await adapter.print(receipt);
    if (isOk(result)) {
      return result;
    }
    lastErr = result;
  }
  // `lastErr` is non-null because we walked at least one adapter
  // (the empty-list guard above ensures the loop ran).
  return lastErr ?? Err('PRINTER_FAILURE', { reason: 'io', cause: 'chain produced no result' });
}

// ---------------------------------------------------------------------------
// selectPrinter / printReceipt
// ---------------------------------------------------------------------------

/**
 * Default chain order per design.md: ESC/POS first, HTML second,
 * PDF last. Frozen so a future caller cannot mutate the array in
 * place — adapters are stateless singletons; reordering the chain
 * is a code change, not a runtime knob.
 */
const DEFAULT_CHAIN: readonly PrinterAdapter[] = Object.freeze([
  escposAdapter,
  htmlAdapter,
  pdfAdapter,
]);

/**
 * Adapter shape exposed to callers so they can swap in a custom
 * chain (the integration test for the post-commit hook does this).
 */
export interface ChainAdapter {
  readonly adapters: readonly PrinterAdapter[];
  print(receipt: ReceiptDTO): Promise<Result<PrintResult>>;
}

/**
 * Returns the active `ChainAdapter`. Today the chain is fixed; a
 * future `Setting('printer.chainOrder')` would be wired here so
 * the operator can reorder the fallback chain (e.g. always print
 * to PDF first when the printer is permanently offline). Kept as a
 * function rather than a constant for that future flexibility, and
 * because design.md > "Adapter contract" spells it as a function.
 */
export function selectPrinter(): ChainAdapter {
  return Object.freeze({
    adapters: DEFAULT_CHAIN,
    print(receipt: ReceiptDTO): Promise<Result<PrintResult>> {
      return runChain(DEFAULT_CHAIN, receipt);
    },
  });
}

/**
 * Sugar for `selectPrinter().print(receipt)`. The post-commit hook
 * calls this; tests can call it directly to exercise the chain in
 * isolation.
 */
export function printReceipt(receipt: ReceiptDTO): Promise<Result<PrintResult>> {
  return selectPrinter().print(receipt);
}

// ---------------------------------------------------------------------------
// postCommitPrint — fire-and-forget hook for pos.service
// ---------------------------------------------------------------------------

/**
 * Environment flag that short-circuits `postCommitPrint`. Set in
 * `tests/property/setup.ts` and `tests/integration/setup.ts` so the
 * test suites don't write hundreds of tmp PDFs during a property
 * run. The check is by exact string match so a typo (`SUPPRESS_RECEIPT_PRINTING=1`
 * with a trailing space) does not silently disable printing in
 * production.
 */
const SUPPRESS_ENV_KEY = 'SUPPRESS_RECEIPT_PRINTING';

/**
 * Internal options for `postCommitPrint`. The defaults wire to the
 * production singletons; tests inject stubs.
 */
export interface PostCommitPrintOptions {
  /** Override the chain that handles the print. Tests inject a recorder. */
  readonly chain?: ChainAdapter;
  /** Override the shop-info loader. Tests inject a recorder. */
  readonly loadShopInfo?: (prisma: ReceiptPrismaLike) => Promise<ReturnType<typeof loadShopInfoFromSettings> extends Promise<infer T> ? T : never>;
  /** Override the receipt-DTO builder. Tests inject a recorder. */
  readonly buildReceipt?: typeof buildReceiptDTO;
  /** Sink for `Err` log lines. Default: `console.error`. */
  readonly errorSink?: (envelope: ErrorEnvelope) => void;
  /** Override the suppress-env check. Tests can force-enable / force-disable. */
  readonly isSuppressed?: () => boolean;
}

/**
 * Default implementation of the suppress check. Reads `process.env`
 * lazily so a test that mutates the env between runs sees the
 * latest value.
 */
function defaultIsSuppressed(): boolean {
  return process.env[SUPPRESS_ENV_KEY] === '1';
}

/**
 * Default error sink — logs the envelope to `console.error` with a
 * stable prefix so log triage can grep for it. Avoids
 * `JSON.stringify(envelope.details)` on the assumption that the
 * details field MAY contain non-serializable content (it doesn't
 * today, but the optional `cause: Error` shape is one schema change
 * away).
 */
function defaultErrorSink(envelope: ErrorEnvelope): void {
  const reason =
    envelope.details !== undefined && typeof envelope.details.reason === 'string'
      ? envelope.details.reason
      : 'unknown';
  const cause =
    envelope.details !== undefined && typeof envelope.details.cause === 'string'
      ? envelope.details.cause
      : '';
   
  console.error(
    `[postCommitPrint] printer chain failed code=${envelope.code} reason=${reason}${
      cause !== '' ? ` cause=${cause}` : ''
    }`,
  );
}

/**
 * Fire-and-forget receipt print invoked by `pos.service` after the
 * finalize transaction commits. NEVER throws and NEVER rejects with
 * a printer error — the sale has already committed; printer
 * failures must not affect the POS UI's flow (Req 4.9).
 *
 * Steps:
 *   1. Short-circuit when `SUPPRESS_RECEIPT_PRINTING=1` (test env).
 *   2. Load the shop-info block via `loadShopInfoFromSettings`.
 *   3. Build the `ReceiptDTO` via `buildReceiptDTO`.
 *   4. Call the chain via `chain.print(receipt)`.
 *   5. Log `Err` envelopes via `errorSink`. Drop `Ok` envelopes
 *      silently — the printer's success is the side effect.
 *
 * Any thrown exception (e.g. `loadShopInfoFromSettings` rejecting
 * because the DB is gone) is caught and logged via `errorSink` so
 * the post-commit promise resolves cleanly. The caller MUST `void`
 * the returned promise — the function never rejects but a bare
 * `await` would still serialize the POS finalize handler against
 * the print, which we do not want.
 */
export async function postCommitPrint(
  sale: SaleDTO,
  prisma: ReceiptPrismaLike,
  options: PostCommitPrintOptions = {},
): Promise<void> {
  const isSuppressed = options.isSuppressed ?? defaultIsSuppressed;
  if (isSuppressed()) {
    return;
  }

  const chain = options.chain ?? selectPrinter();
  const loadShopInfo = options.loadShopInfo ?? loadShopInfoFromSettings;
  const buildReceipt = options.buildReceipt ?? buildReceiptDTO;
  const errorSink = options.errorSink ?? defaultErrorSink;

  try {
    const shopInfo = await loadShopInfo(prisma);
    const receipt = buildReceipt(sale, shopInfo);
    const result = await chain.print(receipt);
    if (!isOk(result)) {
      errorSink(result.error);
    }
  } catch (err) {
    // A truly unexpected throw — the shop-info read failed, the
    // build helper threw, or the chain itself threw despite the
    // adapter contract. Log and swallow so the caller's `void
    // postCommitPrint(...)` never surfaces as an
    // `unhandledRejection`.
    errorSink({
      code: 'PRINTER_FAILURE',
      message: 'post-commit print threw an unexpected error',
      details: {
        reason: 'io',
        cause: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/**
 * Convenience binding that wires `postCommitPrint` to the
 * production Prisma singleton. `pos.service` calls THIS function so
 * the call site stays terse (`void runPostCommitPrint(sale)`).
 *
 * Cast: the production `PrismaClient` is structurally compatible
 * with `ReceiptPrismaLike` (it owns the `setting.findMany` call
 * shape the receipt renderer reads), but the `key: { in: ... }`
 * filter typing in Prisma's generated client uses `string[]` while
 * the structural slice uses `readonly string[]`. The cast bridges
 * the variance — the runtime call is identical and the renderer
 * never mutates the array.
 */
export function runPostCommitPrint(sale: SaleDTO): Promise<void> {
  return postCommitPrint(sale, defaultPrisma as unknown as ReceiptPrismaLike);
}
