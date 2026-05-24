// src/main/printing/html-adapter.ts
//
// HTML printer adapter (Phase 8, task 8.3) — the secondary link in
// the receipt printer chain (design.md > "Receipt Printing
// Pipeline"). Used when the ESC/POS adapter falls through (no
// configured target, malformed config, or hardware I/O failure).
//
// How it works:
//
//   1. Render `ReceiptDTO` to a hand-rolled HTML string sized for
//      80mm thermal paper. The template is intentionally vanilla —
//      no Tailwind, no CSS-in-JS — so the renderer process loads
//      instantly and the bundle has no extra dependencies. Inline
//      `<style>` controls page sizing (`@page { size: 80mm auto;
//      margin: 0 }`) so `webContents.print` produces a paper width
//      that matches the typical 80mm receipt printer.
//
//   2. Convert the HTML to a `data:text/html;base64,...` URL and
//      load it into a freshly-spawned offscreen `BrowserWindow`.
//      The window is `show: false`, has no parent, and is destroyed
//      as soon as the print job dispatches — total wall time is
//      well under a second.
//
//   3. Wait for `did-finish-load`, then call
//      `webContents.print({ silent: true, deviceName: '' })`. The
//      `deviceName: ''` argument tells Electron to use the OS
//      default printer; the operator's per-device targeting work
//      lives on the ESC/POS adapter (Phase 8 task 8.6) so this
//      adapter stays simple.
//
//   4. Resolve when the print callback fires. Electron invokes the
//      callback with `(success, errorReason)`; we map a `false`
//      result to `Err({ reason: 'io', cause })` and fall through
//      to the PDF adapter.
//
// Test environments do NOT have an Electron runtime — `electron` is
// declared a peer dep in `node-thermal-printer` but the actual
// Electron module is only loaded inside the packaged app. The
// adapter detects the missing runtime via a `try { require } catch`
// shim and returns `Err({ reason: 'electron_unavailable' })` so
// the ChainAdapter walks past it without touching `BrowserWindow`.
// Property tests and integration tests run in plain Node and rely
// on this fall-through to land at the PDF adapter (which is
// crash-safe and writes to `os.tmpdir()` when `app` is unavailable).
//
// The adapter NEVER throws. Every error path returns
// `Err('PRINTER_FAILURE', { reason, cause? })` so the chain logic
// stays a straight-line for-loop.
//
// Validates: Requirement 4.8.

import { Err, Ok, type Result } from '@shared/result.js';

import type { PrinterAdapter, PrintResult } from '@main/printing/types.js';
import type {
  ReceiptDTO,
  ReceiptLine,
  ReceiptPayment,
} from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Electron interop — minimal slice the adapter touches
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the `electron` module the adapter needs. Declared
 * structurally so the unit tests can inject a stub without dragging
 * Electron's native binding into the unit-tier `jsdom` environment.
 *
 * The shape mirrors the public surface of Electron's `BrowserWindow`
 * + `app.isReady()`. We touch a tiny subset:
 *   - `app.isReady()`                       — refuse to spawn the
 *     hidden window before Electron's app is ready, otherwise
 *     `BrowserWindow` throws.
 *   - `new BrowserWindow({ show: false })`  — offscreen window.
 *   - `webContents.loadURL(dataUri)`        — load the HTML.
 *   - `webContents.once('did-finish-load')` — wait for layout.
 *   - `webContents.print(opts, cb)`         — dispatch the print
 *     job to the OS default printer.
 *   - `destroy()` / `close()`               — release the window.
 */
export interface ElectronAppLike {
  isReady(): boolean;
}

export interface ElectronWebContentsLike {
  loadURL(url: string): Promise<void>;
  once(
    event: 'did-finish-load',
    listener: () => void,
  ): ElectronWebContentsLike;
  print(
    options: { silent: boolean; deviceName?: string },
    callback: (success: boolean, failureReason?: string) => void,
  ): void;
}

export interface ElectronBrowserWindowLike {
  readonly webContents: ElectronWebContentsLike;
  destroy(): void;
  isDestroyed(): boolean;
}

export type ElectronBrowserWindowCtor = new (init: {
  show: boolean;
  webPreferences?: {
    sandbox?: boolean;
    contextIsolation?: boolean;
    offscreen?: boolean;
  };
}) => ElectronBrowserWindowLike;

export interface ElectronModuleLike {
  readonly app: ElectronAppLike;
  readonly BrowserWindow: ElectronBrowserWindowCtor;
}

/**
 * Loader function returning the Electron module, or `null` when the
 * runtime is not available (test environment, or a hypothetical
 * standalone main-process build that drops Electron).
 *
 * Production wraps `require('electron')` in a `try`/`catch`. Tests
 * inject a recorder stub.
 */
export type ElectronLoader = () => ElectronModuleLike | null;

/**
 * Default loader. Tries `require('electron')`; returns `null` when
 * the module is missing or when the loaded module does not expose
 * the `app` / `BrowserWindow` surface (which is the case under
 * Vitest, where Electron's CommonJS entry point yields a CLI
 * binary path string rather than the module object).
 */
function defaultElectronLoader(): ElectronModuleLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const candidate = require('electron') as unknown;
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      'app' in candidate &&
      'BrowserWindow' in candidate
    ) {
      return candidate as ElectronModuleLike;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

/**
 * Escape `<`, `>`, `&`, `"`, and `'` so a malicious product name or
 * customer note can't inject markup into the rendered receipt. This
 * is the only place we materialize untrusted strings into HTML, so
 * the escape helper is centralized here rather than pulled in from
 * a sanitization library (which would be overkill).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a `ReceiptDTO` to a self-contained HTML document sized for
 * 80mm thermal paper. Inline `<style>` keeps the layout decoupled
 * from any renderer-side stylesheet (the adapter doesn't have one).
 *
 * Sections mirror the ESC/POS layout one-to-one (header, meta,
 * items, totals, payments, footer) so a receipt printed from the
 * HTML fallback looks structurally identical to one printed from
 * thermal hardware. The visual style is utilitarian: monospace
 * font, 12px text, single-pixel rules between sections.
 *
 * Decimal columns flow through `escapeHtml` even though they are
 * digit strings — defense in depth, costs effectively nothing, and
 * keeps the per-section escape rule uniform.
 *
 * Exported for the unit tests that assert template content
 * (shop name, line items, payments, totals) without booting
 * Electron.
 */
export function buildReceiptHtml(receipt: ReceiptDTO): string {
  const itemsHtml = receipt.lines.map(renderLine).join('');
  const paymentsHtml = receipt.payments.map(renderPayment).join('');

  const optionalShop = [
    receipt.shopInfo.address,
    receipt.shopInfo.phone !== null ? `Tel: ${receipt.shopInfo.phone}` : null,
    receipt.shopInfo.taxId !== null ? `Tax ID: ${receipt.shopInfo.taxId}` : null,
  ]
    .filter((value): value is string => value !== null)
    .map((value) => `<div class="shop-line">${escapeHtml(value)}</div>`)
    .join('');

  const customerLine =
    receipt.customerName !== null
      ? `<div class="meta-line">Customer: ${escapeHtml(receipt.customerName)}</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Receipt ${escapeHtml(receipt.serialNo)}</title>
    <style>
      @page { size: 80mm auto; margin: 0; }
      body {
        font-family: 'Courier New', Courier, monospace;
        font-size: 12px;
        line-height: 1.3;
        margin: 0;
        padding: 4mm;
        width: 72mm;
        color: #000;
      }
      .center { text-align: center; }
      .bold { font-weight: bold; }
      .rule {
        border: 0;
        border-top: 1px dashed #000;
        margin: 4px 0;
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .row .label { text-align: left; }
      .row .value { text-align: right; }
      .item-detail { padding-left: 8px; color: #333; }
      .shop-line { font-size: 11px; }
      .meta-line { font-size: 11px; }
    </style>
  </head>
  <body>
    <div class="center bold">${escapeHtml(receipt.shopInfo.name)}</div>
    ${optionalShop}
    <hr class="rule" />
    <div class="meta-line">Receipt: ${escapeHtml(receipt.serialNo)}</div>
    <div class="meta-line">Date: ${escapeHtml(receipt.createdAt)}</div>
    <div class="meta-line">Cashier: ${escapeHtml(receipt.cashierName)}</div>
    ${customerLine}
    <hr class="rule" />
    ${itemsHtml}
    <hr class="rule" />
    <div class="row"><span class="label">Subtotal</span><span class="value">${escapeHtml(receipt.subtotal)}</span></div>
    <div class="row"><span class="label">Discount</span><span class="value">${escapeHtml(receipt.discount)}</span></div>
    <div class="row"><span class="label">Tax</span><span class="value">${escapeHtml(receipt.taxTotal)}</span></div>
    <div class="row bold"><span class="label">Grand Total</span><span class="value">${escapeHtml(receipt.grandTotal)}</span></div>
    <hr class="rule" />
    ${paymentsHtml}
    <hr class="rule" />
    <div class="center">${escapeHtml(receipt.serialNo)}</div>
  </body>
</html>`;
}

/**
 * Render one item as two stacked rows: the name + line total on
 * top, and the `qty × unit` detail underneath. Mirrors the ESC/POS
 * adapter's layout so the HTML fallback looks structurally
 * identical to a thermal-printed receipt.
 */
function renderLine(line: ReceiptLine): string {
  return `<div class="row"><span class="label">${escapeHtml(line.name)}</span><span class="value">${escapeHtml(line.lineTotal)}</span></div>
    <div class="item-detail">${line.quantity} x ${escapeHtml(line.unitPrice)}</div>`;
}

/**
 * Render one payment row. Method label is uppercased so the column
 * reads like a till-tape, matching the ESC/POS adapter's
 * `appendPayment` behaviour.
 */
function renderPayment(payment: ReceiptPayment): string {
  const label = payment.method.toUpperCase();
  return `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(payment.amount)}</span></div>`;
}

// ---------------------------------------------------------------------------
// print
// ---------------------------------------------------------------------------

/**
 * Options for the HTML adapter's `print`. The defaults wire to the
 * production Electron loader; tests inject a recording stub.
 */
export interface HtmlPrintOptions {
  readonly loadElectron?: ElectronLoader;
}

/**
 * Render `receipt` to HTML and ship it to the OS default printer
 * via Electron's `webContents.print`.
 *
 * Returns:
 *   - `Ok({ adapter: 'html' })` when the print callback fires with
 *     `success === true`.
 *   - `Err({ reason: 'electron_unavailable' })` when the loader
 *     returns `null` (test env, or `app` is not yet ready). The
 *     ChainAdapter falls through to PDF.
 *   - `Err({ reason: 'io', cause })` when the print callback fires
 *     with `success === false`, or the load / spawn path throws.
 */
export async function print(
  receipt: ReceiptDTO,
  options: HtmlPrintOptions = {},
): Promise<Result<PrintResult>> {
  const loadElectron = options.loadElectron ?? defaultElectronLoader;

  const electron = loadElectron();
  if (electron === null) {
    return Err('PRINTER_FAILURE', { reason: 'electron_unavailable' });
  }

  // `app.isReady()` is `false` during early bootstrap; spawning a
  // BrowserWindow before then crashes the main process. Treat that
  // as a fall-through condition with the same reason discriminator
  // so the chain logic stays uniform.
  if (!electron.app.isReady()) {
    return Err('PRINTER_FAILURE', { reason: 'electron_unavailable' });
  }

  const html = buildReceiptHtml(receipt);
  const dataUri = `data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`;

  let window: ElectronBrowserWindowLike | null = null;
  try {
    window = new electron.BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        offscreen: true,
      },
    });

    // The hidden window has its own webContents — we work against
    // that handle directly. `loadURL` resolves on navigation start;
    // we still need to wait for `did-finish-load` before printing
    // so the layout is settled.
    const wc = window.webContents;
    const finishedLoading = new Promise<void>((resolve) => {
      wc.once('did-finish-load', () => void resolve());
    });

    await wc.loadURL(dataUri);
    await finishedLoading;

    // Wrap the callback-style API in a Promise so the surrounding
    // code can `await` the print job. Electron invokes the callback
    // exactly once; the `print` method itself does not return a
    // Promise (4.x+).
    const printResult = await new Promise<{
      success: boolean;
      failureReason?: string;
    }>((resolve) => {
      wc.print(
        { silent: true, deviceName: '' },
        (success: boolean, failureReason?: string) => {
          resolve(
            failureReason !== undefined
              ? { success, failureReason }
              : { success },
          );
        },
      );
    });

    if (!printResult.success) {
      return Err('PRINTER_FAILURE', {
        reason: 'io',
        cause: printResult.failureReason ?? 'unknown print failure',
      });
    }
    return Ok({ adapter: 'html' });
  } catch (err) {
    return Err('PRINTER_FAILURE', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Always release the offscreen window, even on the error path.
    // `destroy()` is the synchronous teardown that frees both the
    // C++ window handle and the V8 webContents — preferable to
    // `close()` which posts an event.
    if (window !== null && !window.isDestroyed()) {
      try {
        window.destroy();
      } catch {
        /* swallow — destroy errors are not actionable here */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

/**
 * `PrinterAdapter` instance for the chain. Loads Electron lazily so
 * a non-Electron caller (Vitest) doesn't trigger the native binding
 * load — the loader returns `null` in that case and the chain falls
 * through to PDF.
 */
export const htmlAdapter: PrinterAdapter = Object.freeze({
  name: 'html',
  print(receipt: ReceiptDTO): Promise<Result<PrintResult>> {
    return print(receipt);
  },
});
