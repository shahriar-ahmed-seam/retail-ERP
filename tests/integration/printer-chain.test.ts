// tests/integration/printer-chain.test.ts
//
// Phase 8, task 8.7* — Integration test for printer chain fallback.
//
// Two scenarios drive the real `selectPrinter()` chain end-to-end:
//
//   1. ESC/POS adapter fails → chain falls through to HTML → HTML
//      succeeds → chain resolves with `Ok({ adapter: 'html' })`.
//
//   2. ESC/POS and HTML adapters both fail → chain falls through to
//      the REAL PDF adapter → `pdfkit` writes a real `.pdf` file
//      under `<userData>/receipts/<serialNo>.pdf` on disk → chain
//      resolves with `Ok({ adapter: 'pdf', output: <path> })`.
//
// Mock surface:
//   - `@main/printing/escpos-adapter.js` and
//     `@main/printing/html-adapter.js` are replaced at module level
//     by stubs whose `print` returns a configurable
//     `Result<PrintResult>`. The chain in `printer.ts` imports
//     `escposAdapter` / `htmlAdapter` from these paths, so swapping
//     the modules swaps the chain's first two links in one move.
//   - `@main/printing/pdf-adapter.js` is partially mocked: the real
//     `print` function is preserved (so `pdfkit` + `node:fs` still
//     run for real), but the exported `pdfAdapter` instance is
//     wrapped so it forwards `baseDir: tempUserData`. The wrapped
//     adapter exists for the same reason the real `print` exposes
//     `baseDir` in the first place (per `pdf-adapter.ts`'s
//     `PdfPrintOptions` doc): it's the documented seam for steering
//     the on-disk write location during tests, and it sidesteps
//     the `app.getPath('userData')` lookup that would otherwise
//     require an Electron host. The PDF write itself is NOT
//     mocked.
//
// Note on "throw" vs `Err`:
//   The task wording calls for stubs that "throw" on `print()`, but
//   `runChain()` does not catch thrown rejections — its for-loop
//   `await`s `adapter.print(receipt)` and would propagate any
//   rejection out of the chain. The `PrinterAdapter` contract in
//   `src/main/printing/types.ts` makes the rule explicit: "Adapters
//   MUST NOT throw … every error path returns
//   `Err('PRINTER_FAILURE', { reason, … })`." A real adapter wraps
//   its underlying transport (USB, BrowserWindow) in a try/catch
//   that translates a thrown error to `Err({ reason: 'io', cause })`.
//   The mocks below stand in for that already-translated state, so
//   the chain falls through exactly as it would in production when
//   the real underlying transport fails. Source code is not
//   modified.
//
// Validates: Requirements 4.7, 4.8.

import { existsSync, rmSync } from 'node:fs';

import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { Err, Ok } from '@shared/result.js';

import type { PrintResult } from '@main/printing/types.js';
import type { ReceiptDTO } from '@shared/dto/index.js';
import type { Result } from '@shared/result.js';

// ---------------------------------------------------------------------------
// Hoisted state — usable from `vi.mock` factories
// ---------------------------------------------------------------------------

/**
 * `vi.hoisted` lifts the spy creation + tempdir allocation above the
 * `vi.mock` factories so each factory can capture stable references.
 * The temp dir is created here (rather than in `beforeAll`) because
 * the wrapped PDF adapter's mock factory needs the path before the
 * suite's lifecycle hooks fire.
 *
 * Mirrors the `vi.hoisted` pattern used by every IPC handler test
 * under `tests/unit/main/ipc/handlers/*.test.ts`.
 */
const env = vi.hoisted(() => {
  // Use `require` rather than top-level `import` because
  // `vi.hoisted` is hoisted above the test module's imports — the
  // factory must resolve its own dependencies. Method references
  // are kept attached to their parent module objects so ESLint's
  // `@typescript-eslint/unbound-method` rule stays happy.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');

  return {
    /** Per-suite temp dir; the wrapped PDF adapter writes here. */
    tempUserData: fs.mkdtempSync(path.join(os.tmpdir(), 'printer-chain-it-')),
    escposPrint: vi.fn(),
    htmlPrint: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Replace the ESC/POS adapter module with a stub that exposes the
// same `{ name, print }` shape as the real adapter. The real
// `escposAdapter` reads `Setting('printer.escpos')` from Prisma on
// every call; we never want that DB read in this integration tier.
vi.mock('@main/printing/escpos-adapter.js', () => ({
  escposAdapter: { name: 'escpos' as const, print: env.escposPrint },
}));

// Replace the HTML adapter module with a stub for the same reason —
// the real `htmlAdapter` spawns an offscreen `BrowserWindow` and
// dispatches `webContents.print`, neither of which is available
// outside a packaged Electron host.
vi.mock('@main/printing/html-adapter.js', () => ({
  htmlAdapter: { name: 'html' as const, print: env.htmlPrint },
}));

// Partially mock the PDF adapter module. We keep the real `print`
// function (so `pdfkit` + `node:fs` execute and a true PDF lands on
// disk) but wrap the exported `pdfAdapter` instance so it always
// forwards `baseDir: tempUserData`. Without this, the production
// `defaultUserDataLoader` would `require('electron')`, fail to find
// `app.getPath` outside an Electron host, and fall back to
// `<os.tmpdir()>/core-retail-erp-receipts` — a directory we cannot
// guarantee to clean up. The wrapped adapter steers the write into
// our cleanup-able per-suite temp dir.
vi.mock('@main/printing/pdf-adapter.js', async () => {
  const real = await vi.importActual<
    typeof import('@main/printing/pdf-adapter')
  >('@main/printing/pdf-adapter.js');
  return {
    ...real,
    pdfAdapter: {
      name: 'pdf' as const,
      print: (receipt: ReceiptDTO): Promise<Result<PrintResult>> =>
        real.print(receipt, { baseDir: env.tempUserData }),
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Receipt used by both tests. `serialNo` is `INV-TEST-001` so the
 * PDF assertion can match the on-disk filename exactly. The line
 * count and totals are deliberately minimal — this test asserts
 * chain behaviour, not receipt content.
 */
const SAMPLE_RECEIPT: ReceiptDTO = {
  shopInfo: {
    name: 'Integration Test Shop',
    address: null,
    phone: null,
    taxId: null,
  },
  serialNo: 'INV-TEST-001',
  createdAt: '2026-05-24T07:38:08.000Z',
  cashierName: 'cashier-it',
  customerName: null,
  lines: [
    {
      name: 'Test Widget',
      quantity: 1,
      unitPrice: '5.00',
      lineTotal: '5.00',
      taxRate: '0',
    },
  ],
  subtotal: '5.00',
  discount: '0',
  taxTotal: '0',
  grandTotal: '5.00',
  payments: [{ method: 'cash', amount: '5.00' }],
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterAll(() => {
  // `force: true` silences ENOENT if a subtest already cleaned up;
  // `recursive: true` removes the `receipts/` subdir + any PDFs.
  rmSync(env.tempUserData, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset the per-adapter spies so a previous test's
  // `mockImplementationOnce` does not leak.
  env.escposPrint.mockReset();
  env.htmlPrint.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('printer chain fallback (integration)', () => {
  it('falls through ESC/POS failure to HTML and resolves with adapter=html', async () => {
    // ESC/POS adapter signals a printer-failure envelope. In
    // production this is what the real escpos-adapter returns when
    // its `node-thermal-printer.execute()` call throws — the
    // adapter catches the underlying error and translates it into
    // this exact shape.
    env.escposPrint.mockImplementation(
      (): Promise<Result<PrintResult>> =>
        Promise.resolve(
          Err('PRINTER_FAILURE', {
            reason: 'io',
            cause: 'mock escpos transport failed',
          }),
        ),
    );

    // HTML adapter succeeds. The chain should short-circuit on this
    // Ok and never reach the PDF adapter.
    env.htmlPrint.mockImplementation(
      (): Promise<Result<PrintResult>> =>
        Promise.resolve(Ok({ adapter: 'html' as const })),
    );

    // Lazy import so vi.mock factories above run first. `selectPrinter()`
    // builds its frozen DEFAULT_CHAIN from the (now-mocked) escpos
    // and html modules + the wrapped pdf adapter.
    const { selectPrinter } = await import('@main/printing/printer');
    const result = await selectPrinter().print(SAMPLE_RECEIPT);

    // (a) Chain resolved successfully on the HTML link.
    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrow
    expect(result.value.adapter).toBe('html');

    // (b) ESC/POS was tried first.
    expect(env.escposPrint).toHaveBeenCalledTimes(1);
    expect(env.escposPrint).toHaveBeenCalledWith(SAMPLE_RECEIPT);

    // (c) HTML was invoked once after ESC/POS fell through.
    expect(env.htmlPrint).toHaveBeenCalledTimes(1);
    expect(env.htmlPrint).toHaveBeenCalledWith(SAMPLE_RECEIPT);

    // (d) PDF was NEVER invoked because HTML succeeded — assert by
    //     proxy: no PDF file was written for this serial.
    const pdfPath = `${env.tempUserData}/receipts/INV-TEST-001.pdf`;
    expect(existsSync(pdfPath)).toBe(false);
  });

  it('falls through ESC/POS and HTML failures to PDF and writes the file under receipts/', async () => {
    env.escposPrint.mockImplementation(
      (): Promise<Result<PrintResult>> =>
        Promise.resolve(
          Err('PRINTER_FAILURE', {
            reason: 'io',
            cause: 'mock escpos transport failed',
          }),
        ),
    );
    env.htmlPrint.mockImplementation(
      (): Promise<Result<PrintResult>> =>
        Promise.resolve(
          Err('PRINTER_FAILURE', {
            reason: 'io',
            cause: 'mock html transport failed',
          }),
        ),
    );

    const { selectPrinter } = await import('@main/printing/printer');
    const result = await selectPrinter().print(SAMPLE_RECEIPT);

    // (a) Chain resolved successfully on the PDF link.
    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrow
    expect(result.value.adapter).toBe('pdf');

    // (b) The PDF Ok envelope carries an absolute path under
    //     `<tempUserData>/receipts/<serialNo>.pdf`. We compare on
    //     suffix to stay platform-agnostic about path separators —
    //     `path.join` normalizes them and the production code
    //     emits whichever the host filesystem prefers.
    if (result.value.output === undefined) {
      throw new Error('expected an output path on the PDF Ok envelope');
    }
    expect(result.value.output).toContain(env.tempUserData);
    expect(result.value.output.endsWith('INV-TEST-001.pdf')).toBe(true);

    // (c) The file actually exists on disk — the load-bearing
    //     "PDF file is written under receipts/" assertion. The real
    //     `pdfkit` + `node:fs` write produced this; the test is
    //     not checking a stub.
    expect(existsSync(result.value.output)).toBe(true);

    // (d) ESC/POS tried first, then HTML, then PDF (which produced
    //     the file above). The first two adapters are spies; PDF is
    //     the wrapped real adapter, so its invocation count is
    //     observed via the file's existence on disk.
    expect(env.escposPrint).toHaveBeenCalledTimes(1);
    expect(env.htmlPrint).toHaveBeenCalledTimes(1);
  });
});
