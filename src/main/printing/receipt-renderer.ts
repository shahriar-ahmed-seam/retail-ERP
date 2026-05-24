// src/main/printing/receipt-renderer.ts
//
// Pure mapping layer between a committed `SaleDTO` (what `pos:finalize`
// returns) and the wire-format `ReceiptDTO` that printer adapters
// consume (Phase 8, task 8.1).
//
// Two responsibilities:
//
//   1. `buildReceiptDTO(sale, shopInfo)` — pure shape mapping, no I/O.
//      Every decimal value flows through as the persisted string
//      (`SaleItemDTO.unitPrice`, `lineTotal`, `taxRate`,
//      `Sale.subtotal`, `discount`, `taxTotal`, `grandTotal`,
//      `Payment.amount`). The renderer does no rounding, no currency
//      formatting, and no locale work; that lives in the per-adapter
//      output (ESC/POS, HTML, PDF). Keeping this layer total and
//      side-effect-free is what lets the unit tests cover the mapping
//      without mounting a Prisma client or a printer fixture.
//
//   2. `loadShopInfoFromSettings(prisma)` — read four well-known
//      `Setting` rows (`shop.name`, `shop.address`, `shop.phone`,
//      `shop.taxId`) and project them into a `ReceiptShopInfo`. Missing
//      rows and empty-string values are normalized identically: the
//      shop name defaults to `'Shop'`, every other field defaults to
//      `null` so the renderer can suppress the line. The function
//      accepts a `PrismaLike` parameter (just the slice of the Prisma
//      client this module touches) so unit tests can pass an in-memory
//      mock without spinning up SQLite.
//
// No audit rows, no journal entries, no IPC plumbing — the receipt
// renderer sits below the IPC layer and is invoked post-commit by the
// (still-to-be-built) ChainAdapter (`src/main/printing/printer.ts`,
// task 8.5). Printer failures must never roll the sale back, which is
// why the renderer never opens a transaction and never writes.
//
// Validates: Requirement 4.7.

import type {
  ReceiptDTO,
  ReceiptLine,
  ReceiptPayment,
  ReceiptShopInfo,
  SaleDTO,
} from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Setting-key constants
// ---------------------------------------------------------------------------

/**
 * Well-known `Setting` row keys for the shop-info block printed at the
 * top of every receipt. Listed as a const tuple so a typo here is a
 * compile error rather than a silent missing-row at runtime.
 *
 * Mirrors the rows seeded by `prisma/seed.ts` (Phase 1, task 1.4).
 */
export const SHOP_INFO_SETTING_KEYS = {
  name: 'shop.name',
  address: 'shop.address',
  phone: 'shop.phone',
  taxId: 'shop.taxId',
} as const;

/** Default name used when `shop.name` is missing or empty. */
const DEFAULT_SHOP_NAME = 'Shop';

// ---------------------------------------------------------------------------
// PrismaLike — minimal slice of the Prisma client used by this module
// ---------------------------------------------------------------------------

/**
 * Minimal structural type covering the Prisma surface
 * `loadShopInfoFromSettings` reads. Declared locally (rather than
 * importing `PrismaClient`) so the function is trivially mockable in
 * unit tests without dragging the real client into the unit tier.
 *
 * The shape is `findMany({ where: { key: { in: [...] } } })` returning
 * `{ key, value }` rows — the same call that production uses.
 */
export interface PrismaLike {
  readonly setting: {
    findMany(args: {
      where: { key: { in: readonly string[] } };
      select?: { key: true; value: true };
    }): Promise<readonly { key: string; value: string }[]>;
  };
}

// ---------------------------------------------------------------------------
// buildReceiptDTO — pure mapping
// ---------------------------------------------------------------------------

/**
 * Map a committed `SaleDTO` and a `ReceiptShopInfo` snapshot to the
 * `ReceiptDTO` consumed by the printer chain.
 *
 * Pure function — no I/O, no clock, no randomness. Every decimal value
 * (`unitPrice`, `lineTotal`, `taxRate`, totals, payment amounts) is
 * forwarded as-is from the sale so the printed receipt matches the
 * persisted row exactly (Property 2 holds at the wire boundary too).
 *
 * Item names come straight from `SaleItemDTO.productName` (which is a
 * join at finalize time; see `pos.service.ts#toSaleDTO`). Likewise
 * `cashierName`, `customerName`, `serialNo`, and `createdAt` are
 * forwarded directly. The shop-info block is the only field that does
 * not originate on the sale row — it's loaded once per print by
 * `loadShopInfoFromSettings` and threaded in by the caller.
 */
export function buildReceiptDTO(sale: SaleDTO, shopInfo: ReceiptShopInfo): ReceiptDTO {
  const lines: readonly ReceiptLine[] = sale.items.map(
    (item): ReceiptLine => ({
      name: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      taxRate: item.taxRate,
    }),
  );

  const payments: readonly ReceiptPayment[] = sale.payments.map(
    (payment): ReceiptPayment => ({
      method: payment.method,
      amount: payment.amount,
    }),
  );

  return {
    shopInfo,
    serialNo: sale.serialNo,
    createdAt: sale.createdAt,
    cashierName: sale.cashierName,
    customerName: sale.customerName,
    lines,
    subtotal: sale.subtotal,
    discount: sale.discount,
    taxTotal: sale.taxTotal,
    grandTotal: sale.grandTotal,
    payments,
  };
}

// ---------------------------------------------------------------------------
// loadShopInfoFromSettings — single setting read
// ---------------------------------------------------------------------------

/**
 * Normalize a raw `Setting.value` for the optional shop-info fields
 * (`shop.address`, `shop.phone`, `shop.taxId`). The seed writes empty
 * strings as the unset placeholder, and operators may legitimately
 * blank a field via the settings UI; both shapes collapse to `null` so
 * the renderer can suppress the line rather than print whitespace.
 */
function normalizeOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Normalize the raw `Setting.value` for `shop.name`. The shop name is
 * required at print time so a missing/blank value falls back to a
 * generic `'Shop'` placeholder rather than `null`.
 */
function normalizeName(value: string | undefined): string {
  if (value === undefined) return DEFAULT_SHOP_NAME;
  const trimmed = value.trim();
  return trimmed.length === 0 ? DEFAULT_SHOP_NAME : trimmed;
}

/**
 * Load the four shop-info `Setting` rows in a single round-trip and
 * return a fully-normalized `ReceiptShopInfo`.
 *
 * Missing rows behave identically to empty-string rows: `shop.name`
 * defaults to `'Shop'`, the rest default to `null`. This means a fresh
 * install (where the seed wrote empty strings, see `prisma/seed.ts`)
 * prints a usable receipt without forcing the operator to populate the
 * settings page first.
 *
 * The function is intentionally side-effect-free apart from the DB
 * read: no caching, no audit rows, no error mapping. Callers that care
 * about wrapping the result in a `Result` envelope do so at the IPC
 * layer; here the contract is "always returns a `ReceiptShopInfo`".
 */
export async function loadShopInfoFromSettings(prisma: PrismaLike): Promise<ReceiptShopInfo> {
  const keys = [
    SHOP_INFO_SETTING_KEYS.name,
    SHOP_INFO_SETTING_KEYS.address,
    SHOP_INFO_SETTING_KEYS.phone,
    SHOP_INFO_SETTING_KEYS.taxId,
  ] as const;

  const rows = await prisma.setting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });

  // Project rows into a key→value map. Settings are PK'd by `key`, so
  // duplicates are impossible; nonetheless the last-write-wins
  // reduction below is safe regardless of row ordering.
  const byKey = new Map<string, string>();
  for (const row of rows) {
    byKey.set(row.key, row.value);
  }

  return {
    name: normalizeName(byKey.get(SHOP_INFO_SETTING_KEYS.name)),
    address: normalizeOptional(byKey.get(SHOP_INFO_SETTING_KEYS.address)),
    phone: normalizeOptional(byKey.get(SHOP_INFO_SETTING_KEYS.phone)),
    taxId: normalizeOptional(byKey.get(SHOP_INFO_SETTING_KEYS.taxId)),
  };
}
