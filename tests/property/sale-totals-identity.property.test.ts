// tests/property/sale-totals-identity.property.test.ts
//
// Phase 7, task 7.7 — Property 2: Sale totals identity.
//
// **Validates: Requirements 4.4, 4.5, 4.6.**
//
// For every sale committed by `POSService.finalizeSale`, the persisted
// row MUST satisfy:
//
//     subtotal − discount + taxTotal == grandTotal == sum(payments.amount)
//
// AND the per-line invariant:
//
//     subtotal == sum(items[].quantity × items[].unitPrice)
//
// design.md > "POS Flow" > "Tax computed on post-discount subtotal"
// is explicit that `validateTotalsIdentity` runs BEFORE the
// transaction, but Property 2 is a statement about the PERSISTED
// sale: "trust the row, not the input." This test reads the
// committed `Sale` (joined with its items + payments) back from
// SQLite and asserts the identity against the row columns directly.
//
// Why this lives under `tests/property/` (and not
// `tests/integration/`):
//
//   - The task lives under "Property test" in tasks.md and the file
//     naming convention (`*.property.test.ts`) is recognised only by
//     the `property` Vitest project (vitest.config.ts).
//   - `tests/property/setup.ts` configures fast-check globals (numRuns,
//     verbose, endOnFailure, FAST_CHECK_SEED replay).
//   - DB access is an implementation detail of the property — Property
//     2 cares about the persisted sale, full stop. The property tier
//     is the right home; cross-folder imports of the integration-tier
//     fixture (`tests/integration/fixtures/temp-db.ts`) are fine.
//
// Strategy:
//
//   1. Per-test: create a fresh temp DB via `createTempDb`, seed an
//      Admin user, supplier, categories, and 5 diverse products
//      (varied `sellPrice`, varied `taxRate` including 0 / 0.05 /
//      0.18, `onHand` set to 1_000_000 so the sale's quantity check
//      never gates the property).
//
//   2. fast-check generates a cart per iteration: 1..5 lines, each
//      drawn from the seeded product universe (so FK_VIOLATION cannot
//      fire), quantity 1..5; one fixed-OR-percent discount; 1..3
//      split payments.
//
//   3. The property body computes self-consistent totals via the
//      shared `@shared/pos-totals` module — the SAME math the SUT
//      runs inside its transaction — so the renderer-supplied totals
//      always pass `validateTotalsIdentity` and the sale always
//      commits.
//
//   4. Payments are split into 1..3 amounts that sum to grand total
//      EXACTLY (no float drift): we draw N-1 random fractions of the
//      grand total via Decimal arithmetic and the last payment carries
//      the remainder. This is the deterministic strategy the task
//      description calls out.
//
//   5. The body calls `await fixture.POSService.finalizeSale(input, {
//      userId: actor.id })`. On any non-`Ok` we dump the input + error
//      and fail loudly — Property 2's domain is well-formed inputs, so
//      a rejection here is a bug worth surfacing immediately.
//
//   6. The body reads the persisted sale via
//      `prisma.sale.findUniqueOrThrow({ where: { id }, include: {
//      items, payments } })` and asserts the four identity conditions
//      against the ROW columns. Decimal comparisons go through
//      `decimal.js` to avoid float drift (`'10.50'` and `'10.5'` are
//      equal).
//
//   7. fast-check runs with numRuns: 30 — far below the global default
//      (200) because every iteration drives a real Prisma
//      `$transaction`. 200 transactions per case would slow the suite
//      materially; 30 still gives broad coverage of the cart shape
//      space (5 products × 1..5 lines × 0..50% discount × 1..3
//      payments × cash/card/mobile method mix).
//
// Each iteration's writes accumulate in the per-test DB. That's fine:
// every iteration produces a fresh saleId (the serial counter is
// monotonic), inventory burns down a bit (well below the 1_000_000
// seed), and the next iteration re-reads its own row by saleId.

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
// Per-test seed — shared with Property 8 via `./fixtures/pos-seed.js`
// ---------------------------------------------------------------------------
//
// The 5-product universe (varied `sellPrice` + `taxRate`, `onHand`
// pinned at 1_000_000) is identical between Property 2 (this file)
// and Property 8 (`tax-post-discount.property.test.ts`), so the
// helper lives in `tests/property/fixtures/pos-seed.ts` and both
// files import it. Property 4 (`sale-serials.property.test.ts`)
// uses a different (single-product) seed and inlines its own.

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Cart shape produced by the generator. Resolution into a
 * `FinalizeSaleInput` happens in the property body so the products
 * universe (which is per-test, not per-fast-check-iteration) can be
 * referenced by INDEX rather than embedded in every generated case.
 */
interface CartShape {
  readonly lines: readonly { productIndex: number; quantity: number }[];
  readonly discount: GeneratedDiscount;
  readonly paymentSplit: GeneratedPaymentSplit;
}

type GeneratedDiscount =
  | { readonly kind: 'fixed'; readonly amountCents: number }
  | { readonly kind: 'percent'; readonly percentTimes100: number };

interface GeneratedPaymentSplit {
  /** 1..3. The payment count. */
  readonly count: number;
  /**
   * Length === `count - 1`. Each entry is an integer in `[1, 99]`
   * representing a percentage point share of the grand total
   * carved out for the corresponding payment. The last payment
   * carries `grandTotal − sum(carved_shares)` so the split adds up
   * EXACTLY. Computed in the property body via Decimal arithmetic.
   */
  readonly sharePercents: readonly number[];
  readonly methods: readonly PaymentMethod[];
}

/** Cart with 1..5 lines, each line picking a product by index. */
function cartArbitrary(productCount: number): fc.Arbitrary<CartShape> {
  const lineArb = fc.record({
    productIndex: fc.integer({ min: 0, max: productCount - 1 }),
    quantity: fc.integer({ min: 1, max: 5 }),
  });

  // Discounts:
  //   - `fixed`   : 0..50.00 in cents (0..5000) so `amountCents/100`
  //                 falls in `[0, 50]`. The applyDiscount helper
  //                 clamps to subtotal so an over-cap value can't
  //                 drive a negative grand total.
  //   - `percent` : 0..50% in 0.01 increments. Stored as
  //                 `percentTimes100` (integer 0..50) so the
  //                 generator stays within fast-check's preferred
  //                 integer space; converted to a 2-decimal ratio
  //                 string in the property body.
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

  // Payment split: 1..3 payments; for N payments, generate N-1
  // share-percentages in `[1, 99]` and let the last payment carry the
  // remainder. Method per slot drawn from the three accepted values.
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a generated `GeneratedDiscount` into the wire `DiscountInput`
 * shape with canonical decimal-string values.
 *
 *   - `fixed`   : `amountCents / 100` rendered to two decimal places
 *                 via Decimal so `1234` → `'12.34'` exactly.
 *   - `percent` : `percentTimes100 / 100` rendered to two decimal
 *                 places so `7` → `'0.07'` exactly. The 0.01
 *                 granularity matters: Decimal arithmetic is exact, so
 *                 a percent like `0.123456789` would round-trip but
 *                 stays unrepresentable in a UI; we mirror the
 *                 renderer's two-decimal precision.
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
 * Build self-consistent `SaleItemInput[]` from the generated cart and
 * the seeded product universe.
 *
 *   - `unitPrice` and `taxRate` come from the seeded product's
 *     CANONICAL Decimal forms (e.g. `'5.00'` from the seed re-renders
 *     as `'5'` in the row column thanks to Prisma's Decimal
 *     canonicalization). We pass the SEED string into the input so
 *     the renderer-supplied `unitPrice` and the persisted column
 *     compare equal under `Decimal.equals` regardless of the trailing
 *     zero — every assertion in this test routes through `Decimal`.
 *   - `lineTotal` is `quantity * unitPrice` rendered as a decimal
 *     string. Computed via Decimal so the per-line identity check
 *     inside `pos.service` (Req 4.4) accepts the input.
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
 * Split `grandTotal` into `split.count` payment amounts whose sum is
 * EXACTLY `grandTotal` (decimal-equal).
 *
 * Strategy:
 *   - For `count === 1`: a single payment carrying the full grand
 *     total.
 *   - For `count > 1`: carve `count - 1` shares as percentages of
 *     grand total (each truncated to 2 decimal places), then let the
 *     last payment carry `grandTotal − sum(carved_shares)`. Because
 *     the carved shares are rounded DOWN (`toFixed(2)` truncates the
 *     trailing digit) the remainder is always non-negative and the
 *     last payment is therefore non-negative too.
 *
 * This is the deterministic strategy the task description calls out.
 * It avoids float drift entirely (every operation goes through
 * `decimal.js`) and the resulting payment amounts pass
 * `validateTotalsIdentity` on the first try.
 *
 * Edge cases:
 *   - When `grandTotal === '0'`, every carved share is `'0.00'` and
 *     the last payment is `'0'`. The validator accepts a 0-amount
 *     sale (Req 4.6 only requires `sum(payments) === grandTotal`),
 *     and the persisted row reflects the same.
 *   - When a carved share rounds to a value > grandTotal due to a
 *     near-100% percent share, the carve is clamped to grand total
 *     and remaining shares fall to `'0'` — defensive against an
 *     accumulated rounding overshoot, even though the integer-1..99
 *     bound on `sharePercents` makes this extremely unlikely for
 *     the cart sizes we generate.
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
    // Carved share rounded DOWN to 2 decimals via `toFixed`. Decimal's
    // default rounding for `toFixed` is `ROUND_HALF_UP`; we want a
    // truncation so the remainder is always non-negative — drop digits
    // past 2 by `mul(100).floor().div(100)`.
    const raw = grand.mul(share).dividedBy(100);
    const truncated = raw.mul(100).floor().dividedBy(100);
    // Clamp: if accumulated allocation would exceed grand total,
    // cap this share so the remainder stays >= 0.
    const remainingBudget = grand.minus(allocated);
    const slice = truncated.greaterThan(remainingBudget) ? remainingBudget : truncated;
    amounts.push(slice);
    allocated = allocated.plus(slice);
  }

  // The last payment carries grand − sum(carved). Always >= 0 by
  // construction (allocated <= grand).
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
 * Build a self-consistent `FinalizeSaleInput` from a cart and the
 * seeded products. Runs `@shared/pos-totals` to produce the totals so
 * the result passes `validateTotalsIdentity` on the first try. The
 * SUT will re-validate inside its transaction; this helper exists so
 * the property body can produce inputs that exercise the COMMIT path
 * rather than the VALIDATION-error path.
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

/**
 * Persistence-layer precision tolerance for the totals identity check.
 *
 * `Prisma.Decimal` and `decimal.js` are both built on decimal.js but
 * carry slightly different precision configurations: Prisma normalizes
 * Decimal columns to ~13 significant decimals on the SQLite TEXT
 * round-trip, while `@shared/pos-totals` runs decimal.js at its
 * default 20-significant-digit precision. The result is that a
 * generated cart whose `taxTotal` carries a 15+ digit fraction (e.g.
 * a fixed 0.09 discount on a 92.34 subtotal yields
 * `0.09 / 92.34 ≈ 0.0009746...` and the per-line proportional tax
 * picks up the long tail) loses ~1e-14 worth of precision when each
 * column is read back individually.
 *
 * The persisted ROW is still self-consistent at the level any real
 * POS cares about: the drift is ~14 orders of magnitude below a cent.
 * design.md > "POS Flow" > "Tax computed on post-discount subtotal"
 * does not mandate exact equality; Property 8's wording uses the
 * phrase "within rounding tolerance" for the same reason.
 *
 * `1e-9` is the smallest tolerance that absorbs the observed
 * persistence artifact across the 5-product universe and still
 * surfaces any genuine arithmetic bug — every meaningful monetary
 * disagreement is at least `0.01` (one cent), seven orders of
 * magnitude above this bound. A bug that drifted by, say, `0.00001`
 * would still trip the assertion.
 */
const PERSISTENCE_TOLERANCE = new Decimal('1e-9');

/**
 * Decimal-equality assertion that ignores trailing-zero / canonical
 * form differences (`'10.50'` vs `'10.5'`) and absorbs the
 * persistence-layer precision drift documented above. All Property 2
 * assertions route through this helper.
 *
 * The comparison is `|a − b| <= PERSISTENCE_TOLERANCE`. Failing
 * inequalities dump both values plus the delta so a counterexample
 * fingers the offending column on first inspection.
 */
function expectDecimalEqual(actual: string, expected: string, label: string): void {
  const a = new Decimal(actual);
  const b = new Decimal(expected);
  const delta = a.minus(b).abs();
  if (delta.greaterThan(PERSISTENCE_TOLERANCE)) {
    throw new Error(
      `[Property 2] ${label}: expected ${expected} but row had ${actual} (|Δ|=${delta.toString()} > tolerance ${PERSISTENCE_TOLERANCE.toString()})`,
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
// Property 2 — sale totals identity (Req 4.4, 4.5, 4.6)
// ---------------------------------------------------------------------------

describe('Property 2 (sale totals identity) — POSService.finalizeSale + persisted Sale', () => {
  it(
    'persisted sale satisfies subtotal − discount + taxTotal == grandTotal == sum(payments) and per-line subtotal identity',
    async () => {
      // numRuns: 30 — every iteration drives a real Prisma
      // `$transaction`; 200 (the global default) would slow the
      // suite materially. 30 still spans the 5-product × 1..5-line
      // × 0..50% discount × 1..3-payment search space comfortably,
      // and FAST_CHECK_SEED replay on failure keeps a counterexample
      // reproducible.
      await fc.assert(
        fc.asyncProperty(cartArbitrary(seed.products.length), async (cart) => {
          const input = buildFinalizeInput(cart, seed.products);

          // Drive the SUT against the per-test SQLite. The fixture's
          // dynamic re-import binds `POSService` to the same Prisma
          // singleton as `fixture.prisma`, so seed reads + service
          // writes share the same database file.
          const result = await fixture.POSService.finalizeSale(input, {
            userId: seed.actor.id,
          });

          // Property 2's domain is well-formed inputs. The cart is
          // generated from the seeded product universe (no
          // FK_VIOLATION possible), inventory is at HIGH_ONHAND (no
          // OUT_OF_STOCK possible), totals come from the same
          // `pos-totals` module the SUT uses to validate (no
          // VALIDATION possible). A non-Ok here is therefore a bug
          // in the SUT or in the test scaffolding — fail loudly with
          // the offending input dumped so a counterexample is
          // actionable on first sight.
          if (!result.ok) {
            throw new Error(
              `[Property 2] finalizeSale returned Err: code=${result.error.code} ` +
                `details=${JSON.stringify(result.error.details)} ` +
                `input=${JSON.stringify(input)}`,
            );
          }

          // Read the persisted sale back and assert against the ROW.
          // This is the load-bearing distinction in Property 2 —
          // "trust the row, not the input." The joins (items +
          // payments) come back inline so a single round-trip yields
          // every column the property reads.
          const sale = await fixture.prisma.sale.findUniqueOrThrow({
            where: { id: result.value.saleId },
            include: { items: true, payments: true },
          });

          // (a) Per-line subtotal identity. The row column `subtotal`
          // must equal `sum(items[].quantity * items[].unitPrice)`
          // computed from the persisted SaleItem rows themselves —
          // not from the input. This is what catches a bug where the
          // service writes a tampered subtotal even though the input
          // was self-consistent.
          let recomputedSubtotalFromRow = new Decimal(0);
          for (const item of sale.items) {
            recomputedSubtotalFromRow = recomputedSubtotalFromRow.plus(
              new Decimal(item.unitPrice.toString()).mul(item.quantity),
            );
          }
          expectDecimalEqual(
            sale.subtotal.toString(),
            recomputedSubtotalFromRow.toString(),
            'subtotal == sum(items[].quantity * items[].unitPrice) (Req 4.4)',
          );

          // (b) Totals identity on the persisted row.
          //   subtotal − discount + taxTotal == grandTotal
          // (Req 4.4, 4.5: tax computed on the post-discount
          // subtotal — design.md "POS Flow".) Compared with `Decimal`
          // so the row's canonical form (e.g. `'72.50'` → `'72.5'`)
          // matches the recomputed value regardless of trailing zero.
          const persistedSubtotal = new Decimal(sale.subtotal.toString());
          const persistedDiscount = new Decimal(sale.discount.toString());
          const persistedTax = new Decimal(sale.taxTotal.toString());
          const persistedGrand = new Decimal(sale.grandTotal.toString());

          const recomputedGrand = persistedSubtotal
            .minus(persistedDiscount)
            .plus(persistedTax);

          expectDecimalEqual(
            persistedGrand.toString(),
            recomputedGrand.toString(),
            'subtotal − discount + taxTotal == grandTotal (Req 4.4, 4.5)',
          );

          // (c) Payments identity on the persisted row.
          //   sum(payments[].amount) == grandTotal
          // (Req 4.6.) Sum the row's payment amounts directly so the
          // assertion holds even if the SUT had reordered or
          // collapsed payments at write time (which it does not, but
          // the row is the contract).
          let paymentsSumFromRow = new Decimal(0);
          for (const payment of sale.payments) {
            paymentsSumFromRow = paymentsSumFromRow.plus(
              new Decimal(payment.amount.toString()),
            );
          }
          expectDecimalEqual(
            paymentsSumFromRow.toString(),
            persistedGrand.toString(),
            'sum(payments[].amount) == grandTotal (Req 4.6)',
          );

          // (d) Sanity guards. `items` and `payments` arrays are
          // non-empty (the input had >=1 line and >=1 payment, and
          // `pos.service` rejects empty arrays at validation time).
          // Non-empty here proves the create-with-children path
          // attached every row supplied in the input.
          expect(sale.items.length).toBe(input.items.length);
          expect(sale.payments.length).toBe(input.payments.length);
        }),
        {
          // 30 commits per test is plenty: 5-product × 1..5-line ×
          // 0..50% discount × 1..3-payment × cash/card/mobile gives
          // a search space the property covers comfortably without
          // hammering SQLite for minutes. 200 (the global default)
          // would multiply the per-suite cost without proportionate
          // coverage gain.
          numRuns: 30,
        },
      );
    },
    // The default per-test timeout in vitest.config.ts is 30s; bump
    // to 60s for headroom — 30 real `$transaction` runs against an
    // empty SQLite file fit easily inside that budget on a dev
    // machine, and CI environments occasionally pay a slower spin-up
    // cost on the per-test fixture (migration apply + seed run via
    // npx).
    60_000,
  );
});
