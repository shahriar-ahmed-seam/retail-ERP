// tests/property/tax-post-discount.property.test.ts
//
// Phase 7, task 7.9 — Property 8: Tax line uses post-discount subtotal.
//
// **Validates: Requirements 2.6, 4.5.**
//
// For every committed `Sale`, the persisted `taxTotal` MUST equal
// the per-line proportional tax computed against the post-discount
// subtotal:
//
//     taxTotal == Σ ( item.qty × item.unitPrice × (1 − discount/subtotal) × item.taxRate )
//
// where the sum runs over the persisted `SaleItem` rows. This is the
// formula stated in design.md > "POS Flow > Tax computed on
// post-discount subtotal" and codified in
// `@shared/pos-totals#computeTaxTotal` (Req 2.6, 4.5).
//
// The point of Property 8 — and the reason it lives in the property
// tier rather than as a unit test on `computeTaxTotal` — is to
// verify the FORMULA against the PERSISTED COLUMN end-to-end. The
// recomputation in this test deliberately does NOT call the
// shared module: it walks the formula by hand using `decimal.js`
// arithmetic on the persisted item columns. Two independent
// implementations of the same formula agreeing to within a
// rounding tolerance is a much stronger correctness signal than
// asserting `computeTaxTotal(input) === sale.taxTotal`, because
// the latter would silently pass even if a refactor accidentally
// shipped the renderer-supplied `taxTotal` straight through to
// the column without recomputing.
//
// Strategy:
//
//   1. Per-test: create a fresh temp DB via `createTempDb`, then
//      seed the same 5-product universe as Property 2 via the
//      shared `seedProductUniverse` helper. Diverse `taxRate`
//      values (0, 5%, 18%) give the formula a varied tax-mix to
//      grind on; `onHand = 1_000_000` keeps the out-of-stock
//      branch out of scope.
//
//   2. fast-check generates a cart per iteration (1..5 lines from
//      the seeded universe, integer quantities 1..5; one
//      fixed-OR-percent discount in `[0, 50.00]` / `[0%, 50%]`).
//
//   3. The body builds a self-consistent `FinalizeSaleInput` via
//      `@shared/pos-totals` (the SAME math the SUT runs to validate)
//      so the renderer-supplied totals always pass
//      `validateTotalsIdentity` and the sale always commits.
//
//   4. After the SUT commits, the body reads the persisted sale
//      back and INDEPENDENTLY recomputes the expected tax from the
//      persisted item columns:
//
//          subtotalDec       = Σ items[i].quantity × items[i].unitPrice
//          allocationFactor  = subtotalDec === 0
//                              ? 0
//                              : (1 − persistedDiscount / subtotalDec)
//          recomputedTax     = Σ items[i].quantity × items[i].unitPrice
//                                × allocationFactor
//                                × items[i].taxRate
//
//      Then asserts `Decimal.equals(persistedSale.taxTotal,
//      recomputedTax)` within `1e-9` tolerance — same precision
//      bound the precedent (`sale-totals-identity.property.test.ts`)
//      uses, for the same reason: Prisma's Decimal column
//      round-trip introduces ~1e-14 drift on long fractional
//      tails, well below the `0.01`-cent threshold of any genuine
//      monetary bug.
//
//   5. fast-check runs with `numRuns: 30` (transactional cost) —
//      same trade-off as Property 2: each iteration drives a real
//      Prisma `$transaction`, the global default of 200 would
//      slow the suite, and 30 still spans the search space
//      comfortably.
//
//   6. Edge case: a separate `it()` block seeds a cart drawn ONLY
//      from the tax-free product (`T-0`, `taxRate === '0'`) and
//      asserts `persistedSale.taxTotal === '0'` regardless of
//      discount. Covers the `taxRate.isZero()` fast-path branch
//      in `computeTaxTotal` directly against the persisted row,
//      not via the formula path (which would also produce `0` but
//      via a different code path inside the SUT).

import Decimal from 'decimal.js';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDiscount,
  computeGrandTotal,
  computeSubtotal,
  computeTaxTotal,
  type TotalsItem,
} from '@shared/pos-totals.js';

import {
  PRODUCT_SHAPES,
  seedProductUniverse,
  type SeedData,
  type SeededProduct,
} from './fixtures/pos-seed.js';
import {
  createTempDb,
  type TempDbFixture,
} from '../integration/fixtures/temp-db.js';

import type {
  DiscountInput,
  FinalizeSaleInput,
  PaymentInput,
  PaymentMethod,
  SaleItemInput,
} from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Generators (mirrored from sale-totals-identity.property.test.ts)
// ---------------------------------------------------------------------------
//
// The cart shape is structurally identical to Property 2's: 1..5
// lines into the seeded universe, one fixed-OR-percent discount,
// 1..3 split payments. We do not extract this into a shared
// `cart.arb.ts` because:
//
//   - The two properties may diverge in future (Property 8 might
//     want to cap `discount === 0` paths or oversample non-zero
//     tax rates), and a shared arbitrary makes that
//     divergence awkward.
//   - The arbitrary is small enough that duplication is not a
//     maintenance burden.
//
// If a third POS property test ever needs this shape, the helper
// extraction makes sense; until then, two copies is fine.

interface CartShape {
  readonly lines: readonly { productIndex: number; quantity: number }[];
  readonly discount: GeneratedDiscount;
  readonly paymentSplit: GeneratedPaymentSplit;
}

type GeneratedDiscount =
  | { readonly kind: 'fixed'; readonly amountCents: number }
  | { readonly kind: 'percent'; readonly percentTimes100: number };

interface GeneratedPaymentSplit {
  readonly count: number;
  readonly sharePercents: readonly number[];
  readonly methods: readonly PaymentMethod[];
}

function cartArbitrary(productCount: number): fc.Arbitrary<CartShape> {
  const lineArb = fc.record({
    productIndex: fc.integer({ min: 0, max: productCount - 1 }),
    quantity: fc.integer({ min: 1, max: 5 }),
  });

  // Discount range mirrors Property 2: fixed in `[0, 50.00]` (cents
  // 0..5000), percent in `[0%, 50%]` (0..50 → percent string
  // `'0.00'..'0.50'`). `applyDiscount` clamps both to the subtotal
  // so even a 50% percent on a $0.05 subtotal produces a sane
  // discount amount.
  const discountArb: fc.Arbitrary<GeneratedDiscount> = fc.oneof(
    fc.record({
      kind: fc.constant('fixed' as const),
      amountCents: fc.integer({ min: 0, max: 5000 }),
    }),
    fc.record({
      kind: fc.constant('percent' as const),
      percentTimes100: fc.integer({ min: 0, max: 50 }),
    }),
  );

  const paymentSplitArb: fc.Arbitrary<GeneratedPaymentSplit> = fc
    .integer({ min: 1, max: 3 })
    .chain((count) => {
      const methodsArb = fc.array(
        fc.constantFrom<PaymentMethod>('cash', 'card', 'mobile'),
        { minLength: count, maxLength: count },
      );
      const sharePercentsArb =
        count === 1
          ? fc.constant<readonly number[]>([])
          : fc.array(fc.integer({ min: 1, max: 99 }), {
              minLength: count - 1,
              maxLength: count - 1,
            });
      return fc.record({
        count: fc.constant(count),
        sharePercents: sharePercentsArb,
        methods: methodsArb,
      });
    });

  return fc.record({
    lines: fc.array(lineArb, { minLength: 1, maxLength: 5 }),
    discount: discountArb,
    paymentSplit: paymentSplitArb,
  });
}

// ---------------------------------------------------------------------------
// Helpers (mirror of Property 2)
// ---------------------------------------------------------------------------

/**
 * Convert a generated `GeneratedDiscount` into the wire `DiscountInput`
 * shape with canonical decimal-string values rounded to two decimals
 * (matching the renderer's UI precision).
 */
function toDiscountInput(d: GeneratedDiscount): DiscountInput {
  if (d.kind === 'fixed') {
    return {
      kind: 'fixed',
      amount: new Decimal(d.amountCents).dividedBy(100).toFixed(2),
    };
  }
  return {
    kind: 'percent',
    percent: new Decimal(d.percentTimes100).dividedBy(100).toFixed(2),
  };
}

/**
 * Build self-consistent `SaleItemInput[]` from the generated cart
 * and the seeded product universe. `unitPrice` and `taxRate` come
 * from the seed strings directly so every Decimal comparison
 * downstream goes through `Decimal.equals` and is robust to
 * trailing-zero canonicalisation.
 */
function toItems(
  cart: CartShape,
  products: readonly SeededProduct[],
): readonly SaleItemInput[] {
  return cart.lines.map((l) => {
    const product = products[l.productIndex];
    if (product === undefined) {
      throw new Error(`generator produced out-of-range productIndex ${l.productIndex}`);
    }
    const unitPrice = product.sellPrice;
    const lineTotal = new Decimal(unitPrice).mul(l.quantity).toString();
    return {
      productId: product.id,
      quantity: l.quantity,
      unitPrice,
      taxRate: product.taxRate,
      lineTotal,
    };
  });
}

/**
 * Split `grandTotal` into `split.count` payment amounts that sum to
 * EXACTLY `grandTotal` via Decimal arithmetic — same deterministic
 * strategy Property 2 uses. See
 * `sale-totals-identity.property.test.ts#buildPayments` for the
 * full rationale.
 */
function buildPayments(
  split: GeneratedPaymentSplit,
  grandTotal: string,
): readonly PaymentInput[] {
  const grand = new Decimal(grandTotal);
  if (split.count === 1) {
    const method = split.methods[0];
    if (method === undefined) throw new Error('payment split has count=1 but no method');
    return [{ method, amount: grand.toString() }];
  }

  const amounts: Decimal[] = [];
  let allocated = new Decimal(0);
  for (const share of split.sharePercents) {
    // Truncate carved share to 2 decimals so the remainder stays
    // non-negative; Decimal's default rounding for `toFixed` is
    // half-up, so we drop digits past 2 explicitly via floor.
    const raw = grand.mul(share).dividedBy(100);
    const truncated = raw.mul(100).floor().dividedBy(100);
    const remainingBudget = grand.minus(allocated);
    const slice = truncated.greaterThan(remainingBudget) ? remainingBudget : truncated;
    amounts.push(slice);
    allocated = allocated.plus(slice);
  }
  amounts.push(grand.minus(allocated));

  return amounts.map((amount, i) => {
    const method = split.methods[i];
    if (method === undefined) {
      throw new Error(`payment split missing method at index ${i}`);
    }
    return { method, amount: amount.toString() };
  });
}

/**
 * Build a self-consistent `FinalizeSaleInput`. Runs the shared
 * totals module to ensure the input passes
 * `validateTotalsIdentity` on the first try, so the property body
 * exercises the COMMIT path rather than the VALIDATION-error path.
 */
function buildFinalizeInput(
  cart: CartShape,
  products: readonly SeededProduct[],
): FinalizeSaleInput {
  const items = toItems(cart, products);
  const totalsItems: readonly TotalsItem[] = items.map((it) => ({
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    taxRate: it.taxRate,
  }));

  const subtotal = computeSubtotal(totalsItems);
  const discount = toDiscountInput(cart.discount);
  const discountAmount = applyDiscount(subtotal, discount);
  const taxTotal = computeTaxTotal(totalsItems, subtotal, discountAmount);
  const grandTotal = computeGrandTotal(subtotal, discountAmount, taxTotal);
  const payments = buildPayments(cart.paymentSplit, grandTotal);

  return {
    customerId: null,
    items,
    discount,
    subtotal,
    discountAmount,
    taxTotal,
    grandTotal,
    payments,
  };
}

// ---------------------------------------------------------------------------
// Independent tax recomputation
// ---------------------------------------------------------------------------

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

/**
 * Recompute the expected `taxTotal` against the persisted item
 * columns USING the formula directly — NOT by calling
 * `computeTaxTotal`. This is the load-bearing distinction: Property
 * 8 is asserting the persisted column matches the
 * post-discount-subtotal FORMULA, and the only way to make that
 * assertion stronger than a tautology is to walk the formula by
 * hand here.
 *
 * Inputs are already-canonicalised Decimal strings from the
 * persisted columns (`item.unitPrice.toString()` etc.). Operations
 * stay inside `decimal.js`'s 20-significant-digit precision, the
 * same precision the shared `pos-totals` module runs at.
 *
 * Edge case: when `subtotalDec === 0`, the allocation factor would
 * involve `0 / 0`. The persisted column will be `0` (every line's
 * `qty * unitPrice` is `0`, so every line's contribution is `0`),
 * so we short-circuit `recomputed = 0` to match.
 */
function recomputeExpectedTax(
  items: readonly { quantity: number; unitPrice: string; taxRate: string }[],
  discount: string,
): Decimal {
  let subtotalDec = ZERO;
  for (const item of items) {
    subtotalDec = subtotalDec.plus(new Decimal(item.unitPrice).mul(item.quantity));
  }
  if (subtotalDec.isZero()) return ZERO;

  const discountDec = new Decimal(discount);
  // (1 − discount / subtotal). Clamp to [0, 1] to absorb any
  // pathological case where `discount > subtotal` somehow slipped
  // past the SUT's clamp; the persisted `discount` column is
  // already clamped by `applyDiscount`, so this is defence in
  // depth.
  let allocationFactor = ONE.minus(discountDec.dividedBy(subtotalDec));
  if (allocationFactor.lessThan(ZERO)) allocationFactor = ZERO;
  if (allocationFactor.greaterThan(ONE)) allocationFactor = ONE;

  let recomputed = ZERO;
  for (const item of items) {
    const taxRate = new Decimal(item.taxRate);
    if (taxRate.isZero()) continue; // fast-path: no tax, skip the multiply
    recomputed = recomputed.plus(
      new Decimal(item.unitPrice)
        .mul(item.quantity)
        .mul(allocationFactor)
        .mul(taxRate),
    );
  }
  return recomputed;
}

// ---------------------------------------------------------------------------
// Tolerance + comparison
// ---------------------------------------------------------------------------

/**
 * Same `1e-9` bound used by Property 2
 * (`sale-totals-identity.property.test.ts`). Prisma's
 * `Decimal` round-trip on SQLite normalises to ~13 significant
 * decimals; the shared `pos-totals` module runs at 20 significant
 * decimals; the gap manifests as ~1e-14 drift on long fractional
 * tails. `1e-9` is seven orders of magnitude above the smallest
 * meaningful monetary bug (one cent) so a genuine arithmetic
 * regression would still surface.
 */
const PERSISTENCE_TOLERANCE = new Decimal('1e-9');

/**
 * Decimal-equality assertion that absorbs the persistence drift
 * documented above. All Property 8 numeric assertions route
 * through this helper. Failing inequalities dump both values plus
 * the delta so the offending column is obvious on first inspection.
 */
function expectDecimalEqual(actual: Decimal, expected: Decimal, label: string): void {
  const delta = actual.minus(expected).abs();
  if (delta.greaterThan(PERSISTENCE_TOLERANCE)) {
    throw new Error(
      `[Property 8] ${label}: expected ${expected.toString()} but row had ${actual.toString()} (|Δ|=${delta.toString()} > tolerance ${PERSISTENCE_TOLERANCE.toString()})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fixture: TempDbFixture;
let seed: SeedData;

beforeEach(async () => {
  fixture = await createTempDb();
  seed = await seedProductUniverse(fixture);
});

afterEach(async () => {
  await fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Property 8 — tax line uses post-discount subtotal (Req 2.6, 4.5)
// ---------------------------------------------------------------------------

describe('Property 8 (tax on post-discount subtotal) — POSService.finalizeSale + persisted Sale', () => {
  it(
    'persisted taxTotal == Σ ( qty × unitPrice × (1 − discount/subtotal) × taxRate ) within tolerance',
    async () => {
      // numRuns: 30 — every iteration drives a real Prisma
      // `$transaction`. Same budget as Property 2; the global
      // default (200) would slow the suite without proportionate
      // coverage gain.
      await fc.assert(
        fc.asyncProperty(cartArbitrary(seed.products.length), async (cart) => {
          const input = buildFinalizeInput(cart, seed.products);

          const result = await fixture.POSService.finalizeSale(input, {
            userId: seed.actor.id,
          });

          // Property 8's domain is well-formed inputs (FK fine,
          // inventory at HIGH_ONHAND, totals from the same module
          // the SUT validates with). A non-Ok here is a bug.
          if (!result.ok) {
            throw new Error(
              `[Property 8] finalizeSale returned Err: code=${result.error.code} ` +
                `details=${JSON.stringify(result.error.details)} ` +
                `input=${JSON.stringify(input)}`,
            );
          }

          // Read the PERSISTED sale + its items. The recomputation
          // operates on these row columns (not on `input`) so the
          // assertion is "the row matches the formula", end-to-end.
          const sale = await fixture.prisma.sale.findUniqueOrThrow({
            where: { id: result.value.saleId },
            include: { items: true },
          });

          const persistedItems = sale.items.map((it) => ({
            quantity: it.quantity,
            unitPrice: it.unitPrice.toString(),
            taxRate: it.taxRate.toString(),
          }));

          const recomputed = recomputeExpectedTax(
            persistedItems,
            sale.discount.toString(),
          );

          const persistedTax = new Decimal(sale.taxTotal.toString());

          expectDecimalEqual(
            persistedTax,
            recomputed,
            'taxTotal == Σ ( qty × unitPrice × (1 − discount/subtotal) × taxRate ) (Req 2.6, 4.5)',
          );

          // Sanity guard: the SaleItem count matches the input. A
          // mismatch here would mean the tx wrote a different set
          // of items than it was supposed to, in which case the
          // formula recomputation is the wrong question.
          expect(sale.items.length).toBe(input.items.length);
        }),
        { numRuns: 30 },
      );
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Edge case: tax-free cart → taxTotal === 0 regardless of discount
  // -------------------------------------------------------------------------
  //
  // The shared seed includes `T-0` (taxRate `'0'`). A cart drawn
  // ENTIRELY from `T-0` exercises the `taxRate.isZero()` fast-path
  // branch in `computeTaxTotal` for every line, regardless of how
  // the discount allocation falls. The persisted `taxTotal` MUST be
  // exactly `0` (no tolerance needed — the formula returns the
  // canonical `Decimal(0)` in this branch).
  //
  // We pick a deliberately non-trivial discount (`'10.00'` fixed) to
  // make sure the assertion is not vacuously satisfied by a
  // zero-discount fast-path inside the SUT.
  it('cart of only tax-free products yields taxTotal === 0 regardless of discount', async () => {
    const taxFreeIndex = PRODUCT_SHAPES.findIndex((p) => p.taxRate === '0');
    if (taxFreeIndex === -1) {
      throw new Error(
        '[Property 8 edge] expected a tax-free product in PRODUCT_SHAPES — regression in pos-seed.ts',
      );
    }
    const taxFreeProduct = seed.products[taxFreeIndex];
    if (taxFreeProduct === undefined) {
      throw new Error(
        `[Property 8 edge] seed.products missing index ${taxFreeIndex} — regression in pos-seed.ts`,
      );
    }

    // Two lines of T-0, each quantity 3. Subtotal = 6 * 5.00 =
    // 30.00. Apply a 10.00 fixed discount → discount allocation
    // factor 1 - 10/30 = 2/3. tax = 0 (every line is tax-free).
    const items: readonly SaleItemInput[] = [
      {
        productId: taxFreeProduct.id,
        quantity: 3,
        unitPrice: taxFreeProduct.sellPrice,
        taxRate: taxFreeProduct.taxRate,
        lineTotal: new Decimal(taxFreeProduct.sellPrice).mul(3).toString(),
      },
      {
        productId: taxFreeProduct.id,
        quantity: 3,
        unitPrice: taxFreeProduct.sellPrice,
        taxRate: taxFreeProduct.taxRate,
        lineTotal: new Decimal(taxFreeProduct.sellPrice).mul(3).toString(),
      },
    ];
    const totalsItems: readonly TotalsItem[] = items.map((it) => ({
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      taxRate: it.taxRate,
    }));
    const subtotal = computeSubtotal(totalsItems);
    const discount: DiscountInput = { kind: 'fixed', amount: '10.00' };
    const discountAmount = applyDiscount(subtotal, discount);
    const taxTotal = computeTaxTotal(totalsItems, subtotal, discountAmount);
    const grandTotal = computeGrandTotal(subtotal, discountAmount, taxTotal);

    const input: FinalizeSaleInput = {
      customerId: null,
      items,
      discount,
      subtotal,
      discountAmount,
      taxTotal,
      grandTotal,
      payments: [{ method: 'cash', amount: grandTotal }],
    };

    const result = await fixture.POSService.finalizeSale(input, {
      userId: seed.actor.id,
    });
    if (!result.ok) {
      throw new Error(
        `[Property 8 edge] finalizeSale returned Err: code=${result.error.code} ` +
          `details=${JSON.stringify(result.error.details)}`,
      );
    }

    const sale = await fixture.prisma.sale.findUniqueOrThrow({
      where: { id: result.value.saleId },
    });

    // Exact equality, no tolerance — the fast-path returns the
    // canonical zero. `Decimal.isZero()` is the cleanest way to
    // assert this regardless of the column's stored
    // representation (`'0'` vs `'0.00'` vs `'0E-0'` are all zero).
    const persistedTax = new Decimal(sale.taxTotal.toString());
    expect(persistedTax.isZero()).toBe(true);
  });
});
