// src/main/printing/escpos-adapter.ts
//
// ESC/POS printer adapter (Phase 8, task 8.2) — the primary link in
// the receipt printer chain (design.md > "Receipt Printing
// Pipeline"). Talks to USB / serial / network thermal printers via
// `node-thermal-printer`, which encodes the buffer as ESC/POS
// commands and ships it to the printer over the configured
// interface.
//
// Configuration lives in the `Setting` row keyed `printer.escpos`,
// seeded as `{ kind: 'usb', target: '' }` (see `prisma/seed.ts`).
// The adapter reads the row on every print so a settings update
// (Phase 8 task 8.6) takes effect without a main-process restart.
//
//   - `kind`   — `'usb' | 'serial' | 'network'`. Maps to a
//                `node-thermal-printer` `interface` URI prefix:
//                `printer:` for USB on Windows / `/dev/usb/lp0` on
//                POSIX (the operator types the full target string),
//                `serial:` for serial, `tcp://host:port` for network.
//                The exact target shape is the operator's job;
//                the adapter does not validate it past the
//                discriminator.
//   - `target` — the connection target string. Empty string means
//                "unconfigured": the adapter returns
//                `Err('PRINTER_FAILURE', { reason: 'unconfigured'
//                })` and the ChainAdapter falls through to HTML.
//                This is the load-bearing rule that lets a fresh
//                install (where the seed wrote an empty target)
//                still print receipts via HTML / PDF.
//
// Failure mapping:
//
//   - JSON parse / shape errors → `invalid_config` (chain falls
//     through). The operator fixes the setting; in the meantime the
//     HTML / PDF fallback keeps the POS productive.
//   - Empty `target`           → `unconfigured` (chain falls
//     through). Same UX as `invalid_config`.
//   - Any I/O failure raised by `node-thermal-printer` (USB
//     enumeration error, network timeout, printer offline, paper
//     out detected by `isPrinterConnected`) → `io` with `cause`
//     set to the underlying error message. The chain falls through
//     to HTML.
//
// The adapter NEVER throws. `print` returns `Result<PrintResult>`
// in every code path so the ChainAdapter logic is a straight-line
// for-loop with `if (!result.ok) continue`.
//
// Layout:
//
//   The receipt mirrors design.md > "Receipt Printing Pipeline" —
//   header, shop info, line items, totals block, payments block,
//   footer (serial barcode + cut). All values are forwarded
//   verbatim from `ReceiptDTO`; the adapter does no rounding or
//   currency formatting (those are domain concerns and live on the
//   sale row, see `ReceiptDTO` Note).
//
// Validates: Requirement 4.7.

import { prisma as defaultPrisma } from '@main/db/prisma.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type {
  PrinterAdapter,
  PrintResult,
} from '@main/printing/types.js';
import type {
  ReceiptDTO,
  ReceiptLine,
  ReceiptPayment,
} from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Setting row key carrying the ESC/POS connection config. Listed
 * here as a typed constant so a typo at the call site is a compile
 * error rather than a silent miss at runtime.
 */
const ESC_POS_SETTING_KEY = 'printer.escpos';

/**
 * Thermal-printer line width in characters. 48 is the standard for
 * 80mm paper on most ESC/POS-compliant heads (Epson, Star, Tanca);
 * `node-thermal-printer` uses this for `drawLine` and `leftRight`
 * column alignment so the totals block stays aligned regardless of
 * item-name length.
 */
const RECEIPT_WIDTH = 48;

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/**
 * Parsed shape of `Setting('printer.escpos').value`. `kind`
 * discriminates the connection family; `target` is the URI
 * fragment node-thermal-printer expects after the family prefix
 * (e.g. `printer:Star_TSP100`, `/dev/usb/lp0`, `tcp://192.168.1.50:9100`).
 */
export type EscPosKind = 'usb' | 'serial' | 'network';

export interface EscPosConfig {
  readonly kind: EscPosKind;
  readonly target: string;
}

// ---------------------------------------------------------------------------
// PrismaLike — minimal slice the adapter touches
// ---------------------------------------------------------------------------

/**
 * Minimal Prisma surface the adapter reads. Declared structurally
 * (rather than `import { PrismaClient }`) so unit tests can pass an
 * in-memory stub without dragging the real client in. Mirrors the
 * pattern used by `loadShopInfoFromSettings` in
 * `receipt-renderer.ts`.
 */
export interface PrismaLike {
  readonly setting: {
    findUnique(args: {
      where: { key: string };
      select?: { value: true };
    }): Promise<{ value: string } | null>;
  };
}

// ---------------------------------------------------------------------------
// ThermalPrinterLike — minimal slice the adapter calls
// ---------------------------------------------------------------------------

/**
 * Minimal slice of the `node-thermal-printer` API the adapter uses.
 * Defining it locally lets the unit tests inject a recording stub
 * without spinning up the real native module — `node-thermal-printer`
 * eagerly probes for native USB / serial bindings on construct, which
 * is heavy (and platform-specific) for a test that only wants to
 * assert the command sequence.
 *
 * The shape mirrors the relevant subset of the type declaration in
 * `node-thermal-printer/node-thermal-printer.d.ts` (4.6.0). When the
 * dependency is upgraded the interface here may need to widen, but
 * the adapter only needs the layout primitives + `execute`.
 */
export interface ThermalPrinterLike {
  alignCenter(): void;
  alignLeft(): void;
  alignRight(): void;
  bold(enabled: boolean): void;
  drawLine(character?: string): void;
  leftRight(left: string, right: string): void;
  newLine(): void;
  println(text: string): void;
  print(text: string): void;
  cut(): void;
  isPrinterConnected(): Promise<boolean>;
  execute(): Promise<unknown>;
}

/**
 * Factory that builds a `ThermalPrinterLike` from a config. The
 * production factory wraps `node-thermal-printer`'s
 * `ThermalPrinter`; tests inject a recording stub.
 */
export type ThermalPrinterFactory = (config: EscPosConfig) => ThermalPrinterLike;

// ---------------------------------------------------------------------------
// Default factory — wraps `node-thermal-printer`
// ---------------------------------------------------------------------------

/**
 * Build a real `ThermalPrinter` configured for the given connection
 * shape. The library expects an `interface` string whose shape
 * depends on the platform and connection kind:
 *
 *   - USB:     the operator types the printer name (Windows) or
 *              the device path (POSIX) as `target`. We forward it
 *              verbatim; the library knows how to interpret each
 *              form.
 *   - Serial:  `target` is a serial-port path (`COM3`, `/dev/ttyS0`).
 *              Prefixed with `serial:` per the library's convention.
 *   - Network: `target` is `host:port`; we render it as
 *              `tcp://host:port`.
 *
 * `type` is left at the library's default (`epson`) — that emits the
 * common ESC/POS opcodes that work on every supported brand. Custom
 * brands would require a settings-page change which is deferred to
 * Phase 8 task 8.6.
 *
 * `width` is set to `RECEIPT_WIDTH` (48 chars) so `leftRight` and
 * `drawLine` produce aligned columns on 80mm paper. `removeSpecialCharacters`
 * stays at the default `false` so localized item names round-trip
 * unchanged.
 *
 * @param config — parsed `EscPosConfig`.
 * @returns a `ThermalPrinterLike` ready for command emission.
 */
function defaultFactory(config: EscPosConfig): ThermalPrinterLike {
  // Defer the import so unit tests that inject a custom factory
  // never load the native module. The library's index re-exports
  // `ThermalPrinter` and `PrinterTypes`; both are CommonJS-only,
  // hence `require`. (Main process is Node, so `require` is fine.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lib = require('node-thermal-printer') as {
    ThermalPrinter: new (init: {
      type: string;
      interface: string;
      width: number;
      options?: { timeout?: number };
    }) => ThermalPrinterLike;
    PrinterTypes: { EPSON: string };
  };

  const interfaceUri = buildInterfaceUri(config);
  return new lib.ThermalPrinter({
    type: lib.PrinterTypes.EPSON,
    interface: interfaceUri,
    width: RECEIPT_WIDTH,
    options: { timeout: 5_000 },
  });
}

/**
 * Compose the `interface` string `node-thermal-printer` expects. The
 * library's docs spell out the prefixes; centralizing the mapping
 * here keeps the platform/family knowledge in one place.
 */
function buildInterfaceUri(config: EscPosConfig): string {
  switch (config.kind) {
    case 'usb':
      // `target` is either a Windows printer name or a POSIX device
      // path. Both are accepted as-is by the library's USB driver.
      return config.target;
    case 'serial':
      return `serial:${config.target}`;
    case 'network':
      // Network printers in node-thermal-printer use `tcp://` URIs.
      // The operator types `host:port`; we add the scheme.
      return `tcp://${config.target}`;
    /* istanbul ignore next — exhaustiveness guard */
    default: {
      // The discriminator is exhaustively narrowed above; this
      // branch is unreachable. Throw a typed error so a future
      // schema change surfaces during development.
      const exhaustive: never = config.kind;
      throw new Error(`Unknown ESC/POS kind: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Read and parse the `printer.escpos` setting row.
 *
 *   - Returns `Ok(null)` when the row is missing or holds an empty
 *     string. Caller treats this as `unconfigured`.
 *   - Returns `Err({ reason: 'invalid_config' })` when the JSON is
 *     malformed or the shape does not match `EscPosConfig`.
 *   - Returns `Ok(config)` on a valid parse, INCLUDING the
 *     `target === ''` case — the adapter checks the empty-target
 *     condition separately so the failure reason can be
 *     distinguished from `invalid_config`.
 */
async function loadConfig(
  prisma: PrismaLike,
): Promise<Result<EscPosConfig | null>> {
  const row = await prisma.setting.findUnique({
    where: { key: ESC_POS_SETTING_KEY },
    select: { value: true },
  });
  if (row === null || row.value === '') {
    return Ok(null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch (err) {
    return Err('PRINTER_FAILURE', {
      reason: 'invalid_config',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (!isEscPosConfig(parsed)) {
    return Err('PRINTER_FAILURE', { reason: 'invalid_config' });
  }
  return Ok(parsed);
}

/**
 * Structural narrowing for the parsed JSON. Accepts only the three
 * `kind` discriminators so a malformed row surfaces a typed error
 * instead of a confusing downstream USB-driver crash.
 */
function isEscPosConfig(value: unknown): value is EscPosConfig {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.target !== 'string') return false;
  if (obj.kind !== 'usb' && obj.kind !== 'serial' && obj.kind !== 'network') {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Receipt rendering on the thermal printer buffer
// ---------------------------------------------------------------------------

/**
 * Append every receipt section to the thermal-printer command
 * buffer. The order mirrors design.md > "Receipt Printing Pipeline":
 *
 *   1. Centered shop-info header (name, optional address, phone,
 *      tax id), separated from the body by a horizontal rule.
 *   2. Sale meta (serial number, ISO timestamp, cashier, optional
 *      customer).
 *   3. Item table — left-aligned name column + right-aligned line
 *      total. Quantity × unit price renders on a second line per
 *      item so long names don't wrap mid-row.
 *   4. Totals block (subtotal, discount, tax total, grand total)
 *      using `leftRight` so the value column aligns to the right
 *      edge.
 *   5. Payments block — one row per payment method.
 *   6. Centered footer with the serial number again (the cashier
 *      sometimes tears the top off the receipt) and a final cut.
 *
 * No formatting on the decimal values — every string flows through
 * verbatim from the persisted `Sale` row (the renderer's canonical
 * promise; see `ReceiptDTO`'s doc comment).
 */
function buildReceiptBuffer(
  printer: ThermalPrinterLike,
  receipt: ReceiptDTO,
): void {
  // ----- 1. Header --------------------------------------------------------
  printer.alignCenter();
  printer.bold(true);
  printer.println(receipt.shopInfo.name);
  printer.bold(false);
  if (receipt.shopInfo.address !== null) {
    printer.println(receipt.shopInfo.address);
  }
  if (receipt.shopInfo.phone !== null) {
    printer.println(`Tel: ${receipt.shopInfo.phone}`);
  }
  if (receipt.shopInfo.taxId !== null) {
    printer.println(`Tax ID: ${receipt.shopInfo.taxId}`);
  }
  printer.drawLine();

  // ----- 2. Sale meta -----------------------------------------------------
  printer.alignLeft();
  printer.println(`Receipt: ${receipt.serialNo}`);
  printer.println(`Date:    ${receipt.createdAt}`);
  printer.println(`Cashier: ${receipt.cashierName}`);
  if (receipt.customerName !== null) {
    printer.println(`Customer: ${receipt.customerName}`);
  }
  printer.drawLine();

  // ----- 3. Items ---------------------------------------------------------
  for (const line of receipt.lines) {
    appendItem(printer, line);
  }
  printer.drawLine();

  // ----- 4. Totals --------------------------------------------------------
  printer.leftRight('Subtotal', receipt.subtotal);
  printer.leftRight('Discount', receipt.discount);
  printer.leftRight('Tax', receipt.taxTotal);
  printer.bold(true);
  printer.leftRight('Grand Total', receipt.grandTotal);
  printer.bold(false);
  printer.drawLine();

  // ----- 5. Payments ------------------------------------------------------
  for (const payment of receipt.payments) {
    appendPayment(printer, payment);
  }
  printer.drawLine();

  // ----- 6. Footer + cut --------------------------------------------------
  printer.alignCenter();
  printer.println(receipt.serialNo);
  printer.newLine();
  printer.cut();
}

/**
 * Append a single item to the buffer. The first line is the item
 * name + its line total (right-aligned); the second is `qty × unit`
 * (left-aligned, indented) so a long product name doesn't wrap into
 * the totals column.
 */
function appendItem(printer: ThermalPrinterLike, line: ReceiptLine): void {
  printer.leftRight(line.name, line.lineTotal);
  printer.println(`  ${line.quantity} x ${line.unitPrice}`);
}

/**
 * Append a single payment row. Payment method labels are uppercased
 * (the discriminators are already lowercase ASCII per `PaymentMethod`)
 * so the column reads like a typical till-tape.
 */
function appendPayment(
  printer: ThermalPrinterLike,
  payment: ReceiptPayment,
): void {
  const label = payment.method.toUpperCase();
  printer.leftRight(label, payment.amount);
}

// ---------------------------------------------------------------------------
// print — the PrinterAdapter contract
// ---------------------------------------------------------------------------

/**
 * Internal options for `print`. The defaults wire to the production
 * Prisma client + the real `node-thermal-printer` factory; tests
 * inject stubs.
 */
export interface EscPosPrintOptions {
  readonly prisma?: PrismaLike;
  readonly factory?: ThermalPrinterFactory;
}

/**
 * Render `receipt` and ship it to the configured ESC/POS printer.
 *
 * Steps:
 *   1. Load `Setting('printer.escpos')` via `loadConfig`. On
 *      missing/empty row → `Err({ reason: 'unconfigured' })`. On
 *      malformed JSON → `Err({ reason: 'invalid_config' })`. The
 *      ChainAdapter treats both as fall-through.
 *   2. Build a `ThermalPrinterLike` from the config via the
 *      injected factory (default: real `node-thermal-printer`).
 *   3. Probe `isPrinterConnected()` so we surface a CLEAR `io`
 *      failure when the printer is offline rather than an opaque
 *      `execute()` rejection.
 *   4. Append every section to the printer's command buffer (header,
 *      meta, items, totals, payments, footer + cut).
 *   5. `await printer.execute()` to ship the buffer. Any thrown
 *      error is caught and mapped to `Err({ reason: 'io', cause })`.
 *
 * Returns `Ok({ adapter: 'escpos' })` on success — no `output`
 * field because the side effect is a printed page rather than a
 * file path.
 */
export async function print(
  receipt: ReceiptDTO,
  options: EscPosPrintOptions = {},
): Promise<Result<PrintResult>> {
  const prisma = options.prisma ?? defaultPrisma;
  const factory = options.factory ?? defaultFactory;

  const configResult = await loadConfig(prisma);
  if (!configResult.ok) {
    return configResult;
  }

  const config = configResult.value;
  if (config === null || config.target === '') {
    return Err('PRINTER_FAILURE', { reason: 'unconfigured' });
  }

  // Build the printer + emit the buffer. Factory and library calls
  // are inside the same try/catch so a thrown `require` (e.g. native
  // module load failure) maps to the same `io` envelope as a
  // runtime print failure.
  try {
    const printer = factory(config);

    // Connectivity probe. A `false` here happens when the operator
    // unplugged the printer mid-shift; surface as `io` so the chain
    // falls through and the receipt prints to HTML / PDF instead.
    const connected = await printer.isPrinterConnected();
    if (!connected) {
      return Err('PRINTER_FAILURE', {
        reason: 'io',
        cause: 'printer not connected',
      });
    }

    buildReceiptBuffer(printer, receipt);
    await printer.execute();

    return Ok({ adapter: 'escpos' });
  } catch (err) {
    return Err('PRINTER_FAILURE', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

/**
 * `PrinterAdapter` instance for the chain. Reads the ESC/POS
 * configuration on every call so the operator can re-target the
 * printer via Settings (Phase 8 task 8.6) without bouncing the main
 * process.
 */
export const escposAdapter: PrinterAdapter = Object.freeze({
  name: 'escpos',
  print(receipt: ReceiptDTO): Promise<Result<PrintResult>> {
    return print(receipt);
  },
});
