// src/main/services/pos.service.ts
//
// POS domain service — barcode scan, serial-number allocator, and
// finalize-sale (Phase 7, tasks 7.2 + 7.3 + 7.4).
//
// `scan(barcode)` is the read-only lookup that drives the POS cart's
// "scan to add" UX (Req 4.1, 12.1). A Cashier or Admin sends a freshly
// scanned (or freshly typed) barcode and gets back the matching
// `ProductDTO` with the joined `Inventory.onHand` projected onto the
// wire row, or `null` when no product owns the barcode. No DB writes.
// Target: round-trip well under 200 ms.
//
// `nextSerial(tx)` is the internal serial-number allocator that
// `finalizeSale` calls inside its own `$transaction`. It reads the
// `Setting` row keyed `'sale.serialCounter'`, increments the integer
// value, writes the new value back through the same `tx`, and
// returns the formatted serial (`INV-XXXXXX`, no truncation past
// 999999). By doing the read-modify-write inside the caller's
// transaction the helper inherits SQLite's row-level locking
// semantics: concurrent finalizes serialize on the `Setting` row
// update, the second sees the first's commit, and produces the next
// number. This is the mechanism behind Property 4 in design.md
// (strict monotonicity + uniqueness of sale serials, Req 4.3).
//
// `finalizeSale(input, ctx)` is the write-side entry point for the
// POS flow (Req 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 11.1, 12.2). The whole
// commit fits inside one `prisma.$transaction`:
//
//   1. Validate totals (subtotal, discount, tax, grand, payments-sum
//      vs grand) via the shared `validateTotalsIdentity` — pure
//      recompute, runs outside the transaction.
//   2. Out-of-stock pre-check inside the tx (`findUniqueOrThrow` per
//      line; `applyMovement` is the safety net).
//   3. Allocate the monotonic serial via `nextSerial(tx)`.
//   4. Validate the optional customer FK (P2025 → FK_VIOLATION).
//   5. Insert `Sale` + `SaleItem[]` + `Payment[]` in one nested
//      `tx.sale.create`. Joins (customer, cashier, items.product)
//      come back so `toSaleDTO` does not need a follow-up read.
//   6. For each line, `applyMovement(tx, {delta: -quantity, …})`.
//      Updates the cached `Inventory.onHand` AND inserts the matching
//      `InventoryMovement` row in lock-step (ledger invariant,
//      Property 1).
//   7. Insert one `JournalEntry` of `opType: 'sale'` carrying a
//      replay-friendly snapshot.
//
// Errors are mapped to wire envelopes:
//   - VALIDATION (totals mismatch, malformed line, malformed payment,
//     malformed discount).
//   - OUT_OF_STOCK { productId } (pre-check or `applyMovement`).
//   - FK_VIOLATION { reason: 'not_found' } (customer or product
//     missing — both P2003 and P2025 land here).
//   - INTERNAL (P2002 on `Sale.serialNo` would mean two finalizes
//     truly raced; defensive, the row-update lock prevents it).
//
// After commit (Phase 8 task 8.5 will hook this in) the printer chain
// renders the receipt. Printer failures must never roll the sale
// back, so the post-commit I/O lives outside the transaction.
//
// All three functions are exported on a frozen `POSService` namespace
// literal — same pattern as every other service in this folder
// (`AuthService`, `CategoryService`, `ProductService`,
// `InventoryService`, `PurchaseService`, `SupplierService`).
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 11.1,
//            12.1, 12.2.

import {
  Prisma,
  type Inventory,
  type Payment,
  type Product,
  type Sale,
  type SaleItem,
} from '@prisma/client';

import { prisma } from '@main/db/prisma.js';
import { runPostCommitPrint } from '@main/printing/printer.js';
import { applyMovement, OutOfStockError } from '@main/services/inventory.service.js';
import { validateTotalsIdentity } from '@shared/pos-totals.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type {
  FinalizeSaleInput,
  PaymentDTO,
  PaymentMethod,
  ProductDTO,
  SaleDTO,
  SaleItemDTO,
} from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Setting row key holding the monotonic sale-serial counter (seed: '0'). */
const SERIAL_COUNTER_KEY = 'sale.serialCounter';

/** Minimum width of the numeric portion of a serial; pads with leading zeros. */
const SERIAL_PAD_WIDTH = 6;

// ---------------------------------------------------------------------------
// DTO mapping (mirrors `product.service.ts#toProductDTO`)
// ---------------------------------------------------------------------------

type ProductWithRelations = Product & {
  inventory: Inventory | null;
  category?: { name: string } | null;
};

/**
 * Map a Prisma `Product` row (with optional joined `inventory` and
 * `category` relations) to the wire DTO. Mirrors
 * `product.service.ts#toProductDTO` exactly so a row scanned at the
 * POS looks identical to a row fetched through `products:list` /
 * `products:get`. `onHand` defaults to 0 when the inventory relation
 * has not been hydrated — every product has a matching inventory row
 * by construction (`product.service.ts#upsert` creates them in the
 * same `$transaction`), but the fallback keeps the conversion total
 * so a future shape change can't crash a scan.
 */
function toProductDTO(row: ProductWithRelations): ProductDTO {
  const dto: ProductDTO = {
    id: row.id,
    sku: row.sku,
    name: row.name,
    categoryId: row.categoryId,
    ...(row.category != null ? { categoryName: row.category.name } : {}),
    barcode: row.barcode ?? null,
    buyPrice: row.buyPrice.toString(),
    sellPrice: row.sellPrice.toString(),
    taxRate: row.taxRate.toString(),
    warrantyMonths: row.warrantyMonths,
    reorderLevel: row.reorderLevel,
    onHand: row.inventory?.onHand ?? 0,
  };
  return dto;
}

/**
 * Read-time `include` shape: same shape `product.service.ts` uses for
 * its read paths so the DTO mapper has the joined data it needs in a
 * single round trip. Centralized so a future schema change touches
 * one literal.
 */
const PRODUCT_INCLUDE = {
  inventory: true,
  category: { select: { name: true } },
} as const satisfies Prisma.ProductInclude;

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

/**
 * Look up a product by barcode (Req 4.1, 12.1).
 *
 * Behaviour:
 *   - Validates the input: empty / whitespace-only barcode returns
 *     `Err('VALIDATION', { field: 'barcode' })` so the renderer can
 *     mark the scan input as invalid without surfacing a generic toast.
 *   - Trims surrounding whitespace before the lookup (USB scanners
 *     often append a trailing CR/LF or stray spaces).
 *   - Issues a single `findUnique` against the `Product.barcode`
 *     unique index (`Product_barcode_key`); the include attaches the
 *     `Inventory` and `Category(name)` joins so the wire DTO is
 *     complete in one round trip.
 *   - Returns `Ok(null)` when no product owns the scanned barcode
 *     (per design.md "return ProductDTO | null"). The renderer
 *     renders a "no match" indicator without an error envelope.
 *
 * No DB writes happen on this path — `pos:scan` is the read-only
 * lookup that drives the cart's "scan to add" UX (target round trip
 * < 200 ms).
 */
async function scan(barcode: string): Promise<Result<ProductDTO | null>> {
  if (typeof barcode !== 'string') {
    return Err('VALIDATION', { field: 'barcode' });
  }
  const trimmed = barcode.trim();
  if (trimmed.length === 0) {
    return Err('VALIDATION', { field: 'barcode' });
  }

  const row = await prisma.product.findUnique({
    where: { barcode: trimmed },
    include: PRODUCT_INCLUDE,
  });
  if (row === null) {
    return Ok(null);
  }
  return Ok(toProductDTO(row as ProductWithRelations));
}

// ---------------------------------------------------------------------------
// nextSerial
// ---------------------------------------------------------------------------

/**
 * Allocate the next sale serial number inside the caller's
 * `$transaction` (Req 4.3, design.md > "Serial number allocation",
 * Property 4).
 *
 * Steps (all on the caller's `tx` handle so they share the same
 * transaction boundary as the surrounding finalize):
 *
 *   1. `findUniqueOrThrow` the `Setting` row keyed
 *      `'sale.serialCounter'`. The seed initializes this to `'0'`
 *      and the row is updated in lock-step with every finalize, so
 *      a missing row is a data-integrity bug. We let
 *      `findUniqueOrThrow`'s P2025 propagate; the caller's
 *      transaction rolls back, no sale row is written, and the IPC
 *      router maps the error to `INTERNAL`.
 *
 *   2. Parse the `value` column as a base-10 integer. The seed
 *      script and the previous-iteration write below are the only
 *      writers — both produce well-formed integer strings — so a
 *      malformed value is a `DB_INTEGRITY` bug. We throw a typed
 *      error rather than silently resetting to `0`; the caller's
 *      transaction rolls back, the renderer sees `INTERNAL`, and the
 *      operator can investigate without the audit chain ingesting a
 *      bogus serial.
 *
 *   3. Increment the integer and write the string form back through
 *      the same `tx`. Two concurrent finalizes serialize on this
 *      `update` (SQLite + WAL gives each transaction's write a row
 *      lock until commit), so the second finalize re-reads the
 *      committed value and produces the next number. This is the
 *      mechanism behind strict monotonicity + uniqueness of serials.
 *
 *   4. Return the formatted serial: `INV-` followed by the integer
 *      zero-padded to at least six digits. Numbers above 999999 are
 *      rendered with their natural width (no truncation) so
 *      monotonicity holds for >1M lifetime sales.
 *
 * @throws `Error` (DB_INTEGRITY) when the counter row holds a
 *         non-numeric value. Propagates and rolls the transaction
 *         back; the IPC router maps to `INTERNAL`.
 * @throws Prisma `P2025` when the counter row is missing
 *         (data-integrity bug — the seed always creates it).
 */
async function nextSerial(tx: Prisma.TransactionClient): Promise<string> {
  const row = await tx.setting.findUniqueOrThrow({
    where: { key: SERIAL_COUNTER_KEY },
  });

  // Parse strictly: only digits, optionally with a leading sign. The
  // seeded value is `'0'` and the only other writer is the line below
  // (which always produces a `String(integer)`), so anything else is
  // a corruption signal worth surfacing loudly.
  const parsed = parseStrictInt(row.value);
  if (parsed === null) {
    throw new Error(
      `[POSService.nextSerial] Setting '${SERIAL_COUNTER_KEY}' has a non-numeric value (got: ${JSON.stringify(row.value)})`,
    );
  }

  const next = parsed + 1;
  await tx.setting.update({
    where: { key: SERIAL_COUNTER_KEY },
    data: { value: String(next) },
  });

  return formatSerial(next);
}

/**
 * Parse a decimal integer string. Returns `null` for anything that
 * is not a finite integer in base 10 — `'1.0'`, `'0x10'`, `'1e3'`,
 * `'  42'`, `''`, `'not-a-number'` all reject. We keep the regex
 * narrow on purpose: the only writer of this column is `nextSerial`
 * itself plus the seed, both of which produce a digit-only string.
 */
function parseStrictInt(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (!/^-?\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Format an integer counter value as a sale serial.
 *
 *   `INV-` + (integer zero-padded to at least `SERIAL_PAD_WIDTH` digits)
 *
 * `String#padStart` is a no-op when the rendered integer is already
 * wider than the target — `1000000` renders as `INV-1000000` rather
 * than being clipped — so monotonicity survives a roll past 999999.
 */
function formatSerial(counter: number): string {
  return `INV-${String(counter).padStart(SERIAL_PAD_WIDTH, '0')}`;
}

// ---------------------------------------------------------------------------
// finalizeSale (Phase 7, task 7.4)
// ---------------------------------------------------------------------------
//
// `finalizeSale(input, ctx)` is the write-side entry point for the POS
// flow. The whole commit fits inside one `prisma.$transaction` per
// design.md > "Sale finalize transaction" (Req 4.2, 4.3, 4.4, 4.5,
// 4.6, 4.9, 11.1, 12.2):
//
//   1. `validateTotalsIdentity(input)` — pure recompute of subtotal,
//      discount, tax, grand total + payments-sum vs grand total. Runs
//      OUTSIDE the transaction since it is process-local; on
//      mismatch we surface `Err('VALIDATION', { field, expected,
//      actual })` without touching the DB.
//
//   2. Out-of-stock pre-check INSIDE the transaction: for each line,
//      `findUniqueOrThrow` against `Inventory(productId)` and reject
//      with the typed `OutOfStockError` if `onHand - quantity < 0`.
//      `applyMovement` performs the same check on its own (Req 3.7),
//      so the explicit pre-check is redundant from a correctness
//      standpoint — but it lets a sale with one out-of-stock line
//      among five fail BEFORE the four valid lines + one
//      in-progress write get rolled back, and it matches design.md's
//      pseudocode exactly. `applyMovement` remains the safety net.
//
//   3. Allocate the next monotonic serial via `nextSerial(tx)` —
//      sharing the caller's transaction means SQLite's row-level
//      lock on the `Setting('sale.serialCounter')` row serializes
//      concurrent finalizes (Property 4 in design.md).
//
//   4. Validate the optional `customerId` FK via
//      `tx.customer.findUniqueOrThrow` (P2025 → FK_VIOLATION).
//      Skipped when `customerId` is null — walk-in sales.
//
//   5. Insert `Sale` + `SaleItem[]` + `Payment[]` in a single nested
//      `tx.sale.create` call. Prisma writes the parent first, then
//      the children with the back-FK populated. Joins
//      (`customer`, `cashier`, `items.product`) come back in the
//      same call so `toSaleDTO` does not need a follow-up read.
//
//   6. For each line, `applyMovement(tx, …)` with `delta:
//      -quantity`, `movementType: 'sale'`, `referenceType: 'sale'`,
//      `referenceId: sale.id`. Updates the cached
//      `Inventory.onHand` AND inserts the matching
//      `InventoryMovement` row in lock-step (ledger invariant,
//      Property 1).
//
//   7. Insert one `JournalEntry` of `opType: 'sale'` carrying a
//      replay-friendly snapshot — saleId, serialNo, customerId,
//      cashierId, the four totals (stringified), every line, every
//      payment, the actor, and an ISO timestamp. Symmetric to the
//      `purchase` and `adjustment` journal payloads.
//
// Errors caught outside the transaction body are mapped to wire
// envelopes:
//   - `OutOfStockError` (from the pre-check OR `applyMovement`'s own
//     check) → `Err('OUT_OF_STOCK', { productId })`.
//   - `Prisma.PrismaClientKnownRequestError` with code `P2003`
//     (FK violation on `Sale.customerId` / `Sale.cashierId` /
//     `SaleItem.productId`) → `Err('FK_VIOLATION', { reason: 'not_found' })`.
//   - `Prisma.PrismaClientKnownRequestError` with code `P2025`
//     (record not found from `findUniqueOrThrow` on customer or
//     inventory) → `Err('FK_VIOLATION', { reason: 'not_found' })`.
//   - `Prisma.PrismaClientKnownRequestError` with code `P2002`
//     (unique violation on `Sale.serialNo`) — defensively mapped to
//     `INTERNAL`. The serial is allocated under the row-update lock
//     on `Setting('sale.serialCounter')` so two finalizes truly
//     racing on the same serial is a data-integrity bug, not a
//     user-visible validation error.
//   - Any other error propagates; the IPC router converts it to
//     `Err('INTERNAL', { errorId })`.
//
// After commit (Phase 8 task 8.5 will hook this in) the printer
// chain renders the receipt. We do NOT trigger any I/O here — the
// printer chain isn't built yet, and design.md is explicit that
// printer failures must never roll the sale back.
//
// Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 11.1, 12.2.

/** Allowed payment methods. Mirrors the `PaymentMethod` DTO union. */
const PAYMENT_METHODS: ReadonlySet<PaymentMethod> = new Set(['cash', 'card', 'mobile']);

/** Prisma's known-error codes we map to envelope codes. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';
const PRISMA_FK_VIOLATION = 'P2003';
const PRISMA_RECORD_NOT_FOUND = 'P2025';

/** Re-tag of the `validateTotalsIdentity` failure field for VALIDATION
 *  envelopes — keeps the wire shape stable. */
type TotalsField = 'subtotal' | 'discountAmount' | 'taxTotal' | 'grandTotal' | 'payments';

/**
 * Per-line shape returned by the Sale-create call once the joined
 * `Product.name` is attached. Local interface — Prisma's generated
 * payload types are noisy enough that the explicit shape is easier
 * to read here, and the joins are stable enough that the type does
 * not drift. Mirrors the convention in `purchase.service` and
 * `inventory.service`.
 */
type SaleItemRowWithRelations = SaleItem & {
  product: { name: string };
};

/**
 * Full Sale row shape returned by the create call once every join
 * (`customer`, `cashier`, `items.product`, `payments`) is attached.
 * Drives `toSaleDTO` directly so the wire DTO is round-trip
 * complete in one query.
 */
type SaleRowWithRelations = Sale & {
  customer: { name: string } | null;
  cashier: { username: string };
  items: SaleItemRowWithRelations[];
  payments: Payment[];
};

/**
 * Per-line validation. The renderer ships `unitPrice`, `taxRate`,
 * and `lineTotal` as decimal strings; we re-validate the structural
 * shape AND assert the per-line `lineTotal === quantity * unitPrice`
 * identity (Req 4.4) so a tampered cart cannot poison the totals
 * roll-up. The structural checks here run BEFORE
 * `validateTotalsIdentity` because the totals validator throws on
 * malformed decimals — surfacing the offending field key here gives
 * the renderer a precise error path for the right cart row.
 *
 * Returns `{ ok: true }` on pass, or `{ ok: false; field }` where
 * `field` is the offending key on the line (the caller wraps it in
 * `items[N].<field>`).
 */
function validateLine(item: Record<string, unknown>):
  | { ok: true }
  | { ok: false; field: 'productId' | 'quantity' | 'unitPrice' | 'taxRate' | 'lineTotal' } {
  if (typeof item.productId !== 'string' || item.productId.length === 0) {
    return { ok: false, field: 'productId' };
  }
  if (
    typeof item.quantity !== 'number' ||
    !Number.isFinite(item.quantity) ||
    !Number.isInteger(item.quantity) ||
    item.quantity < 1
  ) {
    return { ok: false, field: 'quantity' };
  }

  // Decimal strings: parseable, finite, non-negative for unitPrice
  // (free items are allowed) and non-negative for taxRate.
  const unitPrice = parseDecimalOrNull(item.unitPrice);
  if (unitPrice === null || unitPrice.lt(0)) {
    return { ok: false, field: 'unitPrice' };
  }
  const taxRate = parseDecimalOrNull(item.taxRate);
  if (taxRate === null || taxRate.lt(0)) {
    return { ok: false, field: 'taxRate' };
  }
  const lineTotal = parseDecimalOrNull(item.lineTotal);
  if (lineTotal === null) {
    return { ok: false, field: 'lineTotal' };
  }

  // Per-line identity (Req 4.4): lineTotal === quantity * unitPrice.
  // Compared with `Decimal.equals` so `'10.50'` and `'10.5'` agree.
  const expectedLineTotal = unitPrice.mul(item.quantity);
  if (!lineTotal.equals(expectedLineTotal)) {
    return { ok: false, field: 'lineTotal' };
  }

  return { ok: true };
}

/**
 * Validate one payment row's structural shape. The numeric value
 * (sum-of-payments vs grand total) is checked by
 * `validateTotalsIdentity`; this only ensures the discriminator and
 * an amount that parses as a non-negative decimal.
 */
function validatePayment(p: Record<string, unknown>):
  | { ok: true }
  | { ok: false; field: 'method' | 'amount' } {
  if (typeof p.method !== 'string' || !PAYMENT_METHODS.has(p.method as PaymentMethod)) {
    return { ok: false, field: 'method' };
  }
  const amount = parseDecimalOrNull(p.amount);
  if (amount === null || amount.lt(0)) {
    return { ok: false, field: 'amount' };
  }
  return { ok: true };
}

/**
 * Validate the discount shape. Numeric clamping and roll-up vs the
 * declared `discountAmount` are handled inside
 * `validateTotalsIdentity`; this just ensures the discriminator and
 * the decimal payload.
 */
function validateDiscountShape(d: unknown): { ok: true } | { ok: false } {
  if (d === null || typeof d !== 'object') return { ok: false };
  const kind = (d as { kind?: unknown }).kind;
  if (kind === 'fixed') {
    const amount = (d as { amount?: unknown }).amount;
    return parseDecimalOrNull(amount) !== null ? { ok: true } : { ok: false };
  }
  if (kind === 'percent') {
    const percent = (d as { percent?: unknown }).percent;
    return parseDecimalOrNull(percent) !== null ? { ok: true } : { ok: false };
  }
  return { ok: false };
}

/**
 * Local decimal parser used for the structural pre-checks.
 * `validateTotalsIdentity` has its own internal parser with the same
 * semantics; we keep this one process-local so `pos.service` does
 * not depend on the totals module's private surface.
 */
function parseDecimalOrNull(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^-?\d+(\.\d+)?$/.test(value)) return null;
  try {
    const dec = new Prisma.Decimal(value);
    if (!dec.isFinite()) return null;
    return dec;
  } catch {
    return null;
  }
}

/**
 * Map a single joined `SaleItem` row to the wire `SaleItemDTO`.
 * Decimals are stringified via their canonical representation so
 * `'10.50'` round-trips as `'10.5'` (matching every other DTO mapper
 * in this codebase).
 */
function toSaleItemDTO(row: SaleItemRowWithRelations): SaleItemDTO {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.product.name,
    quantity: row.quantity,
    unitPrice: row.unitPrice.toString(),
    taxRate: row.taxRate.toString(),
    lineTotal: row.lineTotal.toString(),
  };
}

/** Map a single `Payment` row to the wire `PaymentDTO`. */
function toPaymentDTO(row: Payment): PaymentDTO {
  return {
    id: row.id,
    method: row.method as PaymentMethod,
    amount: row.amount.toString(),
  };
}

/**
 * Map the joined `Sale` row to the wire `SaleDTO`. `customer` and
 * `cashier` are projected from the joins; numeric columns are
 * stringified to keep precision across the JSON round-trip.
 *
 * Note: `SaleDTO.discount` carries the wire field NAME for the
 * stored `Sale.discount` column (which holds the resolved discount
 * AMOUNT). The renderer-supplied input field is `discountAmount`;
 * the column is `discount`. The DTO surfaces `discount` to match
 * the schema — see `dto/sale.ts` Note.
 */
function toSaleDTO(row: SaleRowWithRelations): SaleDTO {
  return {
    id: row.id,
    serialNo: row.serialNo,
    customerId: row.customerId ?? null,
    customerName: row.customer?.name ?? null,
    cashierId: row.cashierId,
    cashierName: row.cashier.username,
    subtotal: row.subtotal.toString(),
    discount: row.discount.toString(),
    taxTotal: row.taxTotal.toString(),
    grandTotal: row.grandTotal.toString(),
    createdAt: row.createdAt.toISOString(),
    items: row.items.map(toSaleItemDTO),
    payments: row.payments.map(toPaymentDTO),
  };
}

/**
 * Atomic POS sale finalize. See the section header above for the
 * full transactional structure and error mapping rules.
 *
 * Returns `Ok({ saleId, serialNo, sale })` matching the
 * `pos:finalize` IPC contract. The `sale` field is the full
 * `SaleDTO` — the same shape the future `sales:detail` channel will
 * return — so the renderer can render the receipt + history row
 * without a follow-up read.
 *
 * Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 11.1, 12.2.
 */
async function finalizeSale(
  input: FinalizeSaleInput,
  ctx: { userId: string },
): Promise<Result<{ saleId: string; serialNo: string; sale: SaleDTO }>> {
  // ---- 1. Pre-transaction validation (no DB hit) -------------------------
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return Err('VALIDATION', { field: 'items' });
  }
  if (!Array.isArray(input.payments) || input.payments.length === 0) {
    return Err('VALIDATION', { field: 'payments' });
  }

  // The DTO declares `items` and `payments` as `readonly` arrays,
  // but `Array.isArray` widens their narrowing to `any[]` under
  // `noUncheckedIndexedAccess`; re-bind through the typed
  // references so the loops stay strongly-typed (mirrors the
  // pattern in `purchase.service`).
  const items: readonly FinalizeSaleInput['items'][number][] = input.items;
  const payments: readonly FinalizeSaleInput['payments'][number][] = input.payments;

  for (let i = 0; i < items.length; i++) {
    const lineCheck = validateLine(items[i] as unknown as Record<string, unknown>);
    if (!lineCheck.ok) {
      return Err('VALIDATION', { field: `items[${i}].${lineCheck.field}` });
    }
  }

  for (let i = 0; i < payments.length; i++) {
    const paymentCheck = validatePayment(
      payments[i] as unknown as Record<string, unknown>,
    );
    if (!paymentCheck.ok) {
      return Err('VALIDATION', { field: `payments[${i}].${paymentCheck.field}` });
    }
  }

  if (!validateDiscountShape(input.discount).ok) {
    return Err('VALIDATION', { field: 'discount' });
  }

  // Totals identity: subtotal, discountAmount, taxTotal, grandTotal,
  // and sum(payments) === grandTotal must all agree with a clean
  // recompute (Property 2). On the first mismatch the validator
  // returns the offending field plus expected/actual decimal
  // strings; we surface them verbatim so the renderer can mark the
  // exact failing total.
  const totalsResult = validateTotalsIdentity(input);
  if (!totalsResult.ok) {
    const field: TotalsField = totalsResult.field;
    return Err('VALIDATION', {
      field,
      expected: totalsResult.expected,
      actual: totalsResult.actual,
    });
  }

  // The customer FK is verified inside the transaction (P2025 maps
  // to FK_VIOLATION). Walk-in sales send `customerId: null` or
  // omit the field; both paths land here as `null`.
  const customerId: string | null = input.customerId ?? null;

  // ---- 2. Atomic write ---------------------------------------------------
  try {
    const committed = await prisma.$transaction(async (tx) => {
      // 2.1 — Out-of-stock pre-check. Walking the lines in input
      // order so the first failing line wins; downstream
      // `applyMovement` calls would surface the same error against
      // the same product even if we skipped this loop, but a fast
      // upfront fail keeps the transaction's write footprint
      // minimal when one of many lines is short.
      for (const line of items) {
        const inv = await tx.inventory.findUniqueOrThrow({
          where: { productId: line.productId },
        });
        if (inv.onHand - line.quantity < 0) {
          throw new OutOfStockError(line.productId);
        }
      }

      // 2.2 — Allocate the monotonic serial on the same tx so the
      // row-level lock on `Setting('sale.serialCounter')`
      // serializes concurrent finalizes.
      const serialNo = await nextSerial(tx);

      // 2.3 — Validate the optional customer FK. We could let
      // Prisma's nested `connect` raise P2003 on the create
      // below, but doing the explicit `findUniqueOrThrow` here
      // keeps the error mapping uniform — both customer and
      // product misses surface as P2025 and map to FK_VIOLATION.
      if (customerId !== null) {
        await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      }

      // 2.4 — Insert Sale + SaleItem[] + Payment[] in one nested
      // create. Prisma writes the parent first, then the children
      // with the back-FK populated.
      const sale = await tx.sale.create({
        data: {
          serialNo,
          customerId,
          cashierId: ctx.userId,
          subtotal: new Prisma.Decimal(input.subtotal),
          discount: new Prisma.Decimal(input.discountAmount),
          taxTotal: new Prisma.Decimal(input.taxTotal),
          grandTotal: new Prisma.Decimal(input.grandTotal),
          items: {
            create: items.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: new Prisma.Decimal(line.unitPrice),
              taxRate: new Prisma.Decimal(line.taxRate),
              lineTotal: new Prisma.Decimal(line.lineTotal),
            })),
          },
          payments: {
            create: payments.map((p) => ({
              method: p.method,
              amount: new Prisma.Decimal(p.amount),
            })),
          },
        },
        include: {
          items: { include: { product: { select: { name: true } } } },
          payments: true,
          customer: { select: { name: true } },
          cashier: { select: { username: true } },
        },
      });

      // 2.5 — Inventory movements. One negative-delta movement per
      // line. `applyMovement` updates `Inventory.onHand` AND
      // inserts the matching `InventoryMovement` row in lock-step,
      // which is what enforces the ledger invariant. The
      // out-of-stock pre-check above means this loop should never
      // throw `OutOfStockError`, but `applyMovement` performs the
      // same check defensively (Req 3.7).
      for (const line of items) {
        await applyMovement(tx, {
          productId: line.productId,
          delta: -line.quantity,
          movementType: 'sale',
          referenceType: 'sale',
          referenceId: sale.id,
          userId: ctx.userId,
        });
      }

      // 2.6 — Journal row. Replay-friendly snapshot symmetric to
      // the purchase + adjustment payloads. Decimals are
      // stringified so the payload survives JSON round-tripping
      // without precision loss.
      await tx.journalEntry.create({
        data: {
          opType: 'sale',
          payload: JSON.stringify({
            saleId: sale.id,
            serialNo,
            customerId,
            cashierId: ctx.userId,
            subtotal: input.subtotal,
            discount: input.discountAmount,
            taxTotal: input.taxTotal,
            grandTotal: input.grandTotal,
            items: items.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              taxRate: line.taxRate,
              lineTotal: line.lineTotal,
            })),
            payments: payments.map((p) => ({
              method: p.method,
              amount: p.amount,
            })),
            userId: ctx.userId,
            timestamp: new Date().toISOString(),
          }),
        },
      });

      return { saleId: sale.id, serialNo, sale: toSaleDTO(sale) };
    });

    // After commit — Phase 8 task 8.5 hooks in the printer chain
    // here. `runPostCommitPrint` is fire-and-forget: it never
    // throws, swallows errors via `console.error`, and the caller
    // `void`s the returned promise so a jammed printer cannot
    // back-pressure the POS UI or surface as an
    // `unhandledRejection`. Printer failures must never roll back
    // the sale (Req 4.9, design.md > "Print after commit").
    void runPostCommitPrint(committed.sale);

    return Ok(committed);
  } catch (err) {
    // OutOfStockError can come from the explicit pre-check OR from
    // `applyMovement`'s own check (defensive — the pre-check
    // should have caught it first).
    if (err instanceof OutOfStockError) {
      return Err('OUT_OF_STOCK', { productId: err.productId });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // Both P2003 (FK violation) and P2025 (record not found from
      // `findUniqueOrThrow`) mean "a referenced row is missing"
      // from this service's perspective:
      //   - P2003 — Sale.customerId / Sale.cashierId / SaleItem.productId
      //     FKs raised at INSERT time.
      //   - P2025 — `findUniqueOrThrow` against the customer or
      //     `Inventory(productId)` row.
      // Both surface as a single envelope so the renderer can
      // render "customer or product not found" without branching.
      if (err.code === PRISMA_FK_VIOLATION || err.code === PRISMA_RECORD_NOT_FOUND) {
        return Err('FK_VIOLATION', { reason: 'not_found' });
      }
      // P2002 (unique violation on `Sale.serialNo`) is a
      // data-integrity bug — the row-update lock on
      // `Setting('sale.serialCounter')` should serialize
      // concurrent finalizes and produce unique serials. Surface
      // as INTERNAL so the operator sees the correlation id.
      if (err.code === PRISMA_UNIQUE_VIOLATION) {
        throw err;
      }
    }
    // Any other error propagates; the IPC router converts it to
    // `Err('INTERNAL', { errorId })`.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POSService surface
// ---------------------------------------------------------------------------

/**
 * POS service surface. Exposed as a frozen object literal for the
 * same reasons as every other service in this folder — callers
 * import a single named symbol and the IPC handler module wires
 * each method to its channel without instantiating a class.
 *
 * `finalizeSale(input, ctx)` is appended in task 7.4 below; the
 * helper functions `nextSerial` and `scan` it depends on are above.
 */
export const POSService = Object.freeze({
  scan,
  nextSerial,
  finalizeSale,
} as const);
