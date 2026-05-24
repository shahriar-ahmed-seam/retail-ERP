/**
 * POS totals math — pure, deterministic, process-agnostic.
 *
 * Single source of truth for how a sale's monetary totals are computed.
 * Both the renderer (which runs this as the cart is built so the cashier
 * sees live totals) and the main process (which re-runs
 * `validateTotalsIdentity` inside the `pos:finalize` transaction) import
 * this exact module. Duplicating the math would invite drift; one copy
 * keeps Property 2 trivially true at the contract boundary.
 *
 * Precision and decimal handling:
 *   The module operates on `decimal.js`'s `Decimal` (the same arbitrary-
 *   precision implementation Prisma's `Prisma.Decimal` is built on) so
 *   per-line proportional-discount allocation never loses precision and
 *   inputs like `'10.50'` and `'10.5'` compare equal. Inputs and outputs
 *   are decimal strings end-to-end, matching the DTO contract documented
 *   in `src/shared/dto/product.ts` and `src/shared/dto/sale.ts`.
 *
 * Algorithm (matches design.md > "POS Flow" > "Tax computed on
 * post-discount subtotal"):
 *
 *   subtotal       = sum(line.quantity * line.unitPrice)
 *   discountAmount = clamp(
 *                       discount.kind === 'percent'
 *                         ? subtotal * clamp(discount.percent, 0, 1)
 *                         : clamp(discount.amount,  0, subtotal),
 *                       0, subtotal,
 *                    )
 *   taxableBase    = subtotal - discountAmount
 *   taxTotal       = sum(
 *                      line.quantity * line.unitPrice
 *                        * (1 - discountAmount/subtotal)   // proportional
 *                        * line.taxRate
 *                    )
 *   grandTotal     = taxableBase + taxTotal
 *
 * Edge cases:
 *   - `subtotal === 0`: every gross line is `0`, so the proportional
 *     allocation factor is undefined but the per-line tax is `0` regardless;
 *     we short-circuit to `taxTotal = '0'` rather than dividing.
 *   - Discount input out of range (negative amount, negative percent,
 *     percent > 1, fixed amount > subtotal): the discount AMOUNT is
 *     clamped to `[0, subtotal]`. This is the right behaviour for a POS
 *     screen that should never produce a negative grand total — it is
 *     also what Property 2's invariant requires.
 *
 * Validates: Requirements 2.6, 4.4, 4.5, 4.6.
 */

import Decimal from 'decimal.js';

import type {
  DiscountInput,
  FinalizeSaleInput,
  PaymentInput,
  SaleItemInput,
} from './dto/sale.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal per-line shape consumed by the totals math.
 *
 * The shared `SaleItemInput` (from `dto/sale.ts`) is a structural superset
 * of this — every cart line passes for free — but exposing the narrower
 * type here lets the renderer compute totals on a working cart row that
 * may not yet have populated optional fields like `lineTotal`.
 */
export interface TotalsItem {
  /** Unit count; positive integer. The math treats this as a `Decimal`. */
  readonly quantity: number;
  /** Per-unit price as a fixed-precision decimal string. */
  readonly unitPrice: string;
  /** Per-line tax rate as a decimal string (e.g. `'0.18'` for 18%). */
  readonly taxRate: string;
}

/**
 * Result of {@link validateTotalsIdentity}.
 *
 * On `ok: false`, `field` identifies the first totals component that did
 * not match its recomputed value, and `expected` / `actual` carry the
 * canonical decimal strings. The IPC handler maps a failure to
 * `Err('VALIDATION', { field, expected, actual })`.
 */
export type TotalsValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly field: 'subtotal' | 'discountAmount' | 'taxTotal' | 'grandTotal' | 'payments';
      readonly expected: string;
      readonly actual: string;
    };

/** Optional knobs accepted by {@link validateTotalsIdentity}. */
export interface ValidateTotalsOptions {
  /**
   * Absolute tolerance applied per-comparison, as a decimal string. Defaults
   * to `'0'` — exact equality, which is what the renderer-and-main contract
   * promises since both sides run the same code on the same inputs. The
   * field exists so a future ingest path (e.g. importing legacy receipts
   * pre-rounded to the cent) can opt into a one-cent slack via `'0.01'`.
   */
  readonly tolerance?: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/**
 * Parse a string-shaped decimal input. Accepts anything `Decimal` accepts
 * (signed digits with an optional decimal point). Returns `null` for any
 * non-string or unparseable input so callers can surface a structured
 * `VALIDATION` error rather than letting an exception bubble.
 */
function parseDecimal(value: unknown): Decimal | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  try {
    return new Decimal(trimmed);
  } catch {
    return null;
  }
}

/**
 * Per-line gross helper used by both subtotal and tax computations. Throws
 * a `TypeError` for malformed inputs because callers (the renderer's POS
 * page and the main process's `finalizeSale`) have already validated their
 * lines against `SaleItemInput`; an unparseable string at this point is a
 * programmer bug, not a request-validation failure.
 */
function lineGross(item: TotalsItem): Decimal {
  const unitPrice = parseDecimal(item.unitPrice);
  if (unitPrice === null) {
    throw new TypeError(`pos-totals: line.unitPrice is not a decimal string (${item.unitPrice})`);
  }
  if (!Number.isFinite(item.quantity) || !Number.isInteger(item.quantity) || item.quantity < 0) {
    throw new TypeError(`pos-totals: line.quantity must be a non-negative integer (${item.quantity})`);
  }
  return unitPrice.times(item.quantity);
}

/** Clamp `value` into `[lo, hi]`. Both bounds inclusive. */
function clamp(value: Decimal, lo: Decimal, hi: Decimal): Decimal {
  if (value.lessThan(lo)) return lo;
  if (value.greaterThan(hi)) return hi;
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sum of `quantity * unitPrice` across every line, as a canonical decimal
 * string.
 *
 * Returns `'0'` for an empty cart. The renderer drives this on every cart
 * mutation; main re-runs it inside `pos:finalize` for Property 2.
 *
 * Validates: Requirement 4.4.
 */
export function computeSubtotal(items: readonly TotalsItem[]): string {
  let subtotal = ZERO;
  for (const item of items) {
    subtotal = subtotal.plus(lineGross(item));
  }
  return subtotal.toString();
}

/**
 * Resolve a `DiscountInput` against a subtotal and return the clamped
 * discount AMOUNT as a decimal string (NOT the post-discount subtotal —
 * the caller does `subtotal - discountAmount` for the taxable base).
 *
 * Behaviour by `discount.kind`:
 *   - `'fixed'`:   `clamp(discount.amount, 0, subtotal)`. Negative amounts
 *                  fall to `0`; amounts exceeding the subtotal cap at the
 *                  subtotal so the post-discount value is never negative.
 *   - `'percent'`: `subtotal * clamp(discount.percent, 0, 1)`, where
 *                  `percent` is a ratio (`'0.10'` = 10%). Out-of-range
 *                  percents are clamped before multiplication; the result
 *                  is then re-clamped to `[0, subtotal]` as a defence in
 *                  depth against precision quirks at the bounds.
 *
 * Throws `TypeError` for malformed inputs (non-string `amount`/`percent`,
 * unknown `kind`).
 *
 * Validates: Requirement 4.5.
 */
export function applyDiscount(subtotal: string, discount: DiscountInput): string {
  const subtotalDec = parseDecimal(subtotal);
  if (subtotalDec === null) {
    throw new TypeError(`pos-totals: subtotal is not a decimal string (${subtotal})`);
  }

  // Subtotal should never be negative; if it is, clamp to zero so we don't
  // produce a negative discount cap.
  const upperBound = subtotalDec.lessThan(ZERO) ? ZERO : subtotalDec;

  let discountAmount: Decimal;

  switch (discount.kind) {
    case 'fixed': {
      const amount = parseDecimal(discount.amount);
      if (amount === null) {
        throw new TypeError(`pos-totals: discount.amount is not a decimal string (${discount.amount})`);
      }
      discountAmount = amount;
      break;
    }
    case 'percent': {
      const percent = parseDecimal(discount.percent);
      if (percent === null) {
        throw new TypeError(`pos-totals: discount.percent is not a decimal string (${discount.percent})`);
      }
      const ratio = clamp(percent, ZERO, ONE);
      discountAmount = upperBound.times(ratio);
      break;
    }
    default: {
      // Exhaustiveness guard; the type system already prevents this.
      const _never: never = discount;
      throw new TypeError(`pos-totals: unknown discount.kind (${String((_never as { kind?: unknown })?.kind)})`);
    }
  }

  return clamp(discountAmount, ZERO, upperBound).toString();
}

/**
 * Total tax across all lines, computed on the post-discount subtotal with
 * proportional per-line allocation per design.md.
 *
 * For each line:
 *   `lineTax = lineGross * (1 - discountAmount/subtotal) * taxRate`
 *
 * Where `lineGross = quantity * unitPrice`. The `(1 - discountAmount/subtotal)`
 * factor is the share of each line that survives the discount; multiplying
 * before tax is what makes `sum(lineTax)` equal to `(subtotal - discountAmount)
 * * weighted_avg_taxRate` and lets the renderer print a per-line tax line that
 * still rolls up to the correct grand total.
 *
 * Edge case: if `subtotal === 0`, every `lineGross` is also `0`, so each
 * `lineTax` is `0` regardless of the (undefined) allocation factor; we
 * short-circuit to `'0'` rather than divide by zero.
 *
 * Validates: Requirements 2.6, 4.5.
 */
export function computeTaxTotal(
  items: readonly TotalsItem[],
  subtotal: string,
  discountAmount: string,
): string {
  const subtotalDec = parseDecimal(subtotal);
  if (subtotalDec === null) {
    throw new TypeError(`pos-totals: subtotal is not a decimal string (${subtotal})`);
  }
  const discountDec = parseDecimal(discountAmount);
  if (discountDec === null) {
    throw new TypeError(`pos-totals: discountAmount is not a decimal string (${discountAmount})`);
  }

  // No subtotal means no taxable base means no tax. Guards both div-by-zero
  // and the negative-subtotal pathological input.
  if (subtotalDec.lessThanOrEqualTo(ZERO)) {
    return ZERO.toString();
  }

  // Allocation factor `(1 - discountAmount/subtotal)`. Clamped to `[0, 1]`
  // so a discount that somehow exceeds the subtotal can't produce a
  // negative line-tax contribution.
  const survivingShare = clamp(ONE.minus(discountDec.dividedBy(subtotalDec)), ZERO, ONE);

  let taxTotal = ZERO;
  for (const item of items) {
    const taxRate = parseDecimal(item.taxRate);
    if (taxRate === null) {
      throw new TypeError(`pos-totals: line.taxRate is not a decimal string (${item.taxRate})`);
    }
    if (taxRate.isZero()) continue; // common fast path: no-tax product
    const gross = lineGross(item);
    taxTotal = taxTotal.plus(gross.times(survivingShare).times(taxRate));
  }

  return taxTotal.toString();
}

/**
 * Grand total: `(subtotal - discountAmount) + taxTotal`, as a decimal
 * string. Negative inputs (which a well-formed cart can't produce) are
 * passed through; the validator catches them.
 *
 * Validates: Requirement 4.4.
 */
export function computeGrandTotal(
  subtotal: string,
  discountAmount: string,
  taxTotal: string,
): string {
  const subtotalDec = parseDecimal(subtotal);
  if (subtotalDec === null) {
    throw new TypeError(`pos-totals: subtotal is not a decimal string (${subtotal})`);
  }
  const discountDec = parseDecimal(discountAmount);
  if (discountDec === null) {
    throw new TypeError(`pos-totals: discountAmount is not a decimal string (${discountAmount})`);
  }
  const taxDec = parseDecimal(taxTotal);
  if (taxDec === null) {
    throw new TypeError(`pos-totals: taxTotal is not a decimal string (${taxTotal})`);
  }
  return subtotalDec.minus(discountDec).plus(taxDec).toString();
}

/**
 * Recompute every monetary component from the cart and discount on
 * `input` and verify it agrees with the renderer-supplied totals plus
 * `sum(payments) === grandTotal`.
 *
 * Returns `{ ok: true }` on full agreement. On the first mismatch, returns
 * `{ ok: false, field, expected, actual }` where `expected` is the value
 * this module recomputed and `actual` is the value the renderer submitted.
 * Comparison uses `Decimal.equals` so `'10.50'` and `'10.5'` are
 * considered identical; an optional absolute `tolerance` (default `'0'`)
 * widens the comparison for ingest paths that accept rounded inputs.
 *
 * Field check order is fixed (`subtotal` → `discountAmount` → `taxTotal`
 * → `grandTotal` → `payments`) so the caller can build a deterministic
 * error message and the property-test harness can assert the exact field
 * a generated mutation should surface.
 *
 * Validates: Requirements 2.6, 4.4, 4.5, 4.6.
 */
export function validateTotalsIdentity(
  input: FinalizeSaleInput,
  options: ValidateTotalsOptions = {},
): TotalsValidation {
  const tolerance = options.tolerance ?? '0';
  const toleranceDec = parseDecimal(tolerance);
  if (toleranceDec === null || toleranceDec.lessThan(ZERO)) {
    throw new TypeError(`pos-totals: tolerance must be a non-negative decimal string (${tolerance})`);
  }

  const items = input.items;

  // Recompute every component from primary inputs.
  const expectedSubtotal = computeSubtotal(items);
  const expectedDiscount = applyDiscount(expectedSubtotal, input.discount);
  const expectedTax = computeTaxTotal(items, expectedSubtotal, expectedDiscount);
  const expectedGrand = computeGrandTotal(expectedSubtotal, expectedDiscount, expectedTax);

  // Field check order matches the function's documented contract.
  const subtotalCheck = compareDecimals(input.subtotal, expectedSubtotal, toleranceDec);
  if (!subtotalCheck.ok) {
    return { ok: false, field: 'subtotal', expected: expectedSubtotal, actual: input.subtotal };
  }

  const discountCheck = compareDecimals(input.discountAmount, expectedDiscount, toleranceDec);
  if (!discountCheck.ok) {
    return {
      ok: false,
      field: 'discountAmount',
      expected: expectedDiscount,
      actual: input.discountAmount,
    };
  }

  const taxCheck = compareDecimals(input.taxTotal, expectedTax, toleranceDec);
  if (!taxCheck.ok) {
    return { ok: false, field: 'taxTotal', expected: expectedTax, actual: input.taxTotal };
  }

  const grandCheck = compareDecimals(input.grandTotal, expectedGrand, toleranceDec);
  if (!grandCheck.ok) {
    return { ok: false, field: 'grandTotal', expected: expectedGrand, actual: input.grandTotal };
  }

  // Payments roll-up: sum(payments.amount) must equal grandTotal.
  const expectedPaymentsSum = sumPayments(input.payments);
  const paymentsCheck = compareDecimals(expectedPaymentsSum, expectedGrand, toleranceDec);
  if (!paymentsCheck.ok) {
    return {
      ok: false,
      field: 'payments',
      expected: expectedGrand,
      actual: expectedPaymentsSum,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers (not exported)
// ---------------------------------------------------------------------------

/**
 * Compare two decimal strings within `tolerance`. Both values must be
 * parseable as decimals or the comparison fails (returns `ok: false`),
 * which is intentional: a malformed value supplied by the renderer is a
 * `VALIDATION` failure on whatever field carried it.
 */
function compareDecimals(a: string, b: string, tolerance: Decimal): { ok: boolean } {
  const aDec = parseDecimal(a);
  const bDec = parseDecimal(b);
  if (aDec === null || bDec === null) return { ok: false };
  if (tolerance.isZero()) {
    return { ok: aDec.equals(bDec) };
  }
  return { ok: aDec.minus(bDec).abs().lessThanOrEqualTo(tolerance) };
}

/**
 * Sum of payment amounts as a canonical decimal string. Treats a malformed
 * amount as `0` so the validator surfaces the mismatch through the
 * payments-vs-grand-total check rather than throwing.
 */
function sumPayments(payments: readonly PaymentInput[]): string {
  let total = ZERO;
  for (const payment of payments) {
    const amount = parseDecimal(payment.amount);
    if (amount === null) continue;
    total = total.plus(amount);
  }
  return total.toString();
}

// Type-only re-exports so a consumer can import everything related to
// totals from one place without duplicating the DTO module path.
export type { DiscountInput, FinalizeSaleInput, PaymentInput, SaleItemInput };
