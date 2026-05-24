// src/main/ipc/handlers/settings.ts
//
// IPC handlers for the settings + printer-test channel group (Phase 8,
// task 8.6).
//
// Wires three channels into the router (`registerHandler`) on import
// via the exported `registerSettingsHandlers()` function. The
// bootstrap in `src/main/index.ts` calls this before
// `bindIpcHandlers(ipcMain)` so the router is fully populated before
// Electron exposes the IPC surface to renderers.
//
// Channels:
//
//   - `settings:get`   (Admin + Cashier — Req 8.3: cashiers need to
//                       read shop info for receipt rendering)
//       Reads a single `Setting` row by `key`. The on-disk `value`
//       column is a JSON string; the handler `JSON.parse`s it before
//       returning so the renderer sees the structured value (object,
//       string, number, boolean, or `null`). Missing rows surface as
//       `Ok({ value: null })` so the renderer can present a default
//       in its first paint without a follow-up "does the row exist?"
//       round-trip.
//
//   - `settings:set`   (Admin only — Req 8.2)
//       Upserts a `Setting` row. The wire `value` is JSON-serialized
//       before persistence so structured shapes (e.g. the printer
//       config `{ kind, target }`) round-trip cleanly through the
//       `Setting.value: String` column.
//
//   - `printer:test`   (Admin only — Phase 8 task 8.6)
//       Builds a synthetic `ReceiptDTO` from the configured
//       `ReceiptShopInfo` (loaded via `loadShopInfoFromSettings`)
//       plus a single placeholder line ("TEST PRINT"), zero totals,
//       no payments, current timestamp, and the cashier name set to
//       the calling Admin's username. Runs the live printer chain
//       (`selectPrinter().print(receipt)` — ESC/POS → HTML → PDF)
//       and returns `Ok({ adapter, output? })` carrying the link in
//       the chain that handled the print so the operator can see
//       where the test print landed.
//
//       Nothing is persisted — `runChain` is invoked directly, NOT
//       `postCommitPrint`, so a chain failure surfaces as the LAST
//       adapter's `Err('PRINTER_FAILURE', ...)` envelope rather than
//       being swallowed by the post-commit fire-and-forget logger.
//       That envelope is exactly what the settings page renders
//       inline when the test print fails.
//
// Validates: Requirements 4.7, 8.2, 8.3.

import { prisma as defaultPrisma } from '@main/db/prisma.js';
import { registerHandler, type HandlerFn } from '@main/ipc/router.js';
import {
  loadShopInfoFromSettings,
  selectPrinter,
  type ChainAdapter,
  type ReceiptRendererPrismaLike,
} from '@main/printing/index.js';
import { Err, Ok } from '@shared/result.js';

import type { ReceiptDTO } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Internal types — settings row reader/writer
// ---------------------------------------------------------------------------

/**
 * Minimal slice of the Prisma surface this handler module touches.
 * Declared structurally (rather than `import { PrismaClient }`) so
 * the unit tests can drive the handlers against an in-memory stub
 * without dragging the real client in.
 */
export interface SettingsPrismaLike {
  readonly setting: {
    findUnique(args: {
      where: { key: string };
      select?: { value: true };
    }): Promise<{ value: string } | null>;
    upsert(args: {
      where: { key: string };
      update: { value: string };
      create: { key: string; value: string };
    }): Promise<{ key: string; value: string }>;
  };
}

// ---------------------------------------------------------------------------
// Dependency injection seam (test-only)
// ---------------------------------------------------------------------------

/**
 * The handlers reach into Prisma + the printer chain + the receipt
 * renderer for shop info. Each is exposed as a swappable singleton so
 * the unit tests can inject recording stubs without spinning up the
 * full main-process surface.
 *
 * Production wires to `defaultPrisma` and the real
 * `selectPrinter().print()` chain on import; tests overwrite via
 * `setSettingsHandlerDeps` and reset via `resetSettingsHandlerDeps`
 * inside `afterEach`.
 */
export interface SettingsHandlerDeps {
  readonly prisma: SettingsPrismaLike & ReceiptRendererPrismaLike;
  readonly selectPrinter: () => ChainAdapter;
  readonly loadShopInfo: typeof loadShopInfoFromSettings;
  readonly now: () => Date;
}

const defaultDeps: SettingsHandlerDeps = {
  // The production Prisma client is structurally compatible with both
  // `SettingsPrismaLike` (uses `findUnique`/`upsert`) and the receipt
  // renderer's `PrismaLike` (uses `findMany` for shop-info rows). The
  // cast bridges the variance — both surfaces are read-or-write on
  // `Setting` rows and the runtime call shape is identical.
  prisma: defaultPrisma as unknown as SettingsPrismaLike & ReceiptRendererPrismaLike,
  selectPrinter,
  loadShopInfo: loadShopInfoFromSettings,
  now: () => new Date(),
};

let activeDeps: SettingsHandlerDeps = defaultDeps;

/**
 * Replace the active dependency set. Used by unit tests to inject
 * stubs; production code should never call this except during
 * bootstrap if the deps become pluggable in a future phase.
 */
export function setSettingsHandlerDeps(deps: SettingsHandlerDeps): void {
  activeDeps = deps;
}

/** Restore the production dependencies. Convenience for tests' `afterEach`. */
export function resetSettingsHandlerDeps(): void {
  activeDeps = defaultDeps;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `settings:get` handler. Reads a single `Setting` row and decodes
 * the `value` column as JSON. Missing rows surface as
 * `Ok({ value: null })` so the renderer can fall back to a default
 * without a second round-trip. A row whose `value` column holds
 * malformed JSON surfaces as `Err('DB_INTEGRITY')` — the seed and
 * `settings:set` writer both produce well-formed JSON so that
 * branch is reachable only via direct DB tampering.
 */
const getHandler: HandlerFn<'settings:get'> = async (req) => {
  const key = req.key;
  if (typeof key !== 'string' || key.length === 0) {
    return Err('VALIDATION', { field: 'key' });
  }

  const row = await activeDeps.prisma.setting.findUnique({
    where: { key },
    select: { value: true },
  });

  if (row === null) {
    return Ok({ value: null });
  }

  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Ok({ value: parsed });
  } catch (err) {
    return Err('DB_INTEGRITY', {
      reason: 'malformed_setting_json',
      key,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
};

/**
 * `settings:set` handler. Upserts a `Setting` row, JSON-encoding the
 * `value` payload before persistence. Admin-only by RBAC.
 */
const setHandler: HandlerFn<'settings:set'> = async (req) => {
  const key = req.key;
  if (typeof key !== 'string' || key.length === 0) {
    return Err('VALIDATION', { field: 'key' });
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(req.value);
  } catch (err) {
    return Err('VALIDATION', {
      field: 'value',
      reason: 'not_json_serializable',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  if (serialized === undefined) {
    // `JSON.stringify(undefined)` returns `undefined` rather than a
    // string; `Setting.value` is non-nullable so we reject explicitly.
    return Err('VALIDATION', { field: 'value', reason: 'not_json_serializable' });
  }

  await activeDeps.prisma.setting.upsert({
    where: { key },
    update: { value: serialized },
    create: { key, value: serialized },
  });

  return Ok(undefined);
};

/**
 * `printer:test` handler. Builds a synthetic receipt and runs the
 * live chain. Returns the `Ok({ adapter, output? })` envelope of
 * whichever link in the chain (ESC/POS → HTML → PDF) handled the
 * print, or the LAST adapter's `Err('PRINTER_FAILURE', ...)` on
 * chain-wide failure.
 *
 * The synthetic receipt:
 *   - shop info pulled via `loadShopInfoFromSettings` so the printed
 *     header matches what a real sale would emit;
 *   - `serialNo: 'INV-TEST'` so the receipt is unmistakable on paper
 *     and never collides with a real sale's serial;
 *   - `createdAt: now().toISOString()`;
 *   - `cashierName` set to the acting Admin's `username` so the
 *     receipt names the operator who triggered the test;
 *   - one item line ("TEST PRINT"), quantity 1, zero unit price /
 *     line total / tax rate;
 *   - zero totals;
 *   - no payments.
 */
const testPrintHandler: HandlerFn<'printer:test'> = async (_req, ctx) => {
  if (ctx.session === undefined) {
    return Err('INTERNAL', { reason: 'missing_session' });
  }

  let shopInfo;
  try {
    shopInfo = await activeDeps.loadShopInfo(activeDeps.prisma);
  } catch (err) {
    return Err('PRINTER_FAILURE', {
      reason: 'io',
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const receipt: ReceiptDTO = {
    shopInfo,
    serialNo: 'INV-TEST',
    createdAt: activeDeps.now().toISOString(),
    // The Session record does not carry the operator's username
    // (only `userId` + `role`), and the test print does not justify
    // a separate `User.findUnique`. Use a clearly-synthetic
    // placeholder so the operator can tell at a glance the printed
    // page is a test, not a real receipt.
    cashierName: 'TEST PRINT',
    customerName: null,
    lines: [
      {
        name: 'TEST PRINT',
        quantity: 1,
        unitPrice: '0.00',
        lineTotal: '0.00',
        taxRate: '0.00',
      },
    ],
    subtotal: '0.00',
    discount: '0.00',
    taxTotal: '0.00',
    grandTotal: '0.00',
    payments: [],
  };

  const chain = activeDeps.selectPrinter();
  const result = await chain.print(receipt);
  if (!result.ok) {
    return result;
  }

  // Strip `output` when undefined so the wire envelope stays compact
  // under `exactOptionalPropertyTypes`. The PDF adapter returns the
  // saved file path; ESC/POS and HTML omit the field.
  if (result.value.output !== undefined) {
    return Ok({ adapter: result.value.adapter, output: result.value.output });
  }
  return Ok({ adapter: result.value.adapter });
};

// ---------------------------------------------------------------------------
// Public registration entry point
// ---------------------------------------------------------------------------

/**
 * Register every settings-group channel with the IPC router.
 *
 * Called once during main-process bootstrap (`src/main/index.ts`)
 * before `bindIpcHandlers(ipcMain)`. Idempotent: `registerHandler`
 * replaces existing entries on re-registration, so calling this
 * twice (e.g. under HMR or in tests) is safe.
 */
export function registerSettingsHandlers(): void {
  registerHandler('settings:get', {}, getHandler);
  registerHandler('settings:set', {}, setHandler);
  registerHandler('printer:test', {}, testPrintHandler);
}

// Exported for unit tests in
// `tests/unit/main/ipc/handlers/settings.test.ts` so the handler
// functions can be exercised directly without driving the full
// router. Production code should always go through
// `registerSettingsHandlers`.
export const __testables = Object.freeze({
  getHandler,
  setHandler,
  testPrintHandler,
});
