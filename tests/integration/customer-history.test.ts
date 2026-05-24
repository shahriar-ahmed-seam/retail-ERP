// tests/integration/customer-history.test.ts
//
// Phase 9, task 9.4* — Integration test for the customer detail
// history sub-list.
//
// Drives the real `CustomerService.detail` against a per-test SQLite
// database (via the `temp-db` fixture) and asserts that, after two
// sales are finalized against the same customer, the customer detail
// payload returns both `Sale` rows ordered by `(createdAt DESC, id)`
// — i.e. most recent first (Req 7.3).
//
// The test seeds:
//   - one `Cashier` user as the actor (`ctx.userId`),
//   - one `Category` + `Product` (+ `Inventory` row at onHand 5 so two
//     single-line sales of quantity 1 each commit without OOS),
//   - one `Customer` to attach both sales to,
//
// then finalizes two sales in sequence through the real
// `POSService.finalizeSale`. The natural creation order makes
// `sale1.createdAt <= sale2.createdAt`; a 5 ms gap between the two
// finalize calls forces distinct millisecond-precision DATETIME
// values on the SQLite side so the DESC sort is deterministic
// regardless of host clock granularity.
//
// Validates: Requirements 7.3.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDb, type TempDbFixture } from './fixtures/temp-db.js';

import type { FinalizeSaleInput } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Per-test seed shape
// ---------------------------------------------------------------------------

/**
 * Minimum business set the customer-history flow touches. Mirrors the
 * shape used by `pos.service.test.ts` so the two suites stay
 * recognizably similar.
 */
interface SeedData {
  readonly actor: { id: string; username: string };
  readonly product: { id: string; sku: string };
  readonly customer: { id: string; name: string };
}

async function seedFixtureData(fixture: TempDbFixture): Promise<SeedData> {
  const cashierRole = await fixture.prisma.role.findUniqueOrThrow({
    where: { name: 'Cashier' },
  });

  const actor = await fixture.prisma.user.create({
    data: {
      username: 'test-cashier',
      passwordHash: 'test-not-a-real-hash',
      roleId: cashierRole.id,
    },
  });

  const category = await fixture.prisma.category.create({
    data: { name: 'Test Category' },
  });

  const product = await fixture.prisma.product.create({
    data: {
      sku: 'SKU-HIST',
      name: 'History Item',
      categoryId: category.id,
      buyPrice: '5.00',
      sellPrice: '10.00',
      taxRate: '0',
    },
  });

  // Inventory at onHand 5 — two single-line sales of quantity 1 each
  // commit without tripping OOS.
  await fixture.prisma.inventory.create({
    data: { productId: product.id, onHand: 5 },
  });

  const customer = await fixture.prisma.customer.create({
    data: { name: 'Repeat Buyer', phone: '555-0100' },
  });

  return {
    actor: { id: actor.id, username: actor.username },
    product: { id: product.id, sku: product.sku },
    customer: { id: customer.id, name: customer.name },
  };
}

// ---------------------------------------------------------------------------
// Finalize-input builder
// ---------------------------------------------------------------------------

/**
 * Build a one-line, one-payment finalize input that satisfies the
 * totals identity (`1 × 10.00, taxRate 0, no discount → grand 10`)
 * and attaches the supplied customer. Identical structure to the
 * input used by `pos.service.test.ts`'s attached-customer scenario.
 */
function makeInput(productId: string, customerId: string): FinalizeSaleInput {
  return {
    customerId,
    items: [
      {
        productId,
        quantity: 1,
        unitPrice: '10.00',
        taxRate: '0',
        lineTotal: '10',
      },
    ],
    discount: { kind: 'fixed', amount: '0' },
    subtotal: '10',
    discountAmount: '0',
    taxTotal: '0',
    grandTotal: '10',
    payments: [{ method: 'cash', amount: '10' }],
  };
}

/**
 * Sleep for `ms` milliseconds. Used to space the two finalize calls
 * far enough apart that SQLite's DATETIME column records distinct
 * `createdAt` values for them. SQLite stores millisecond precision
 * via Prisma; 5 ms is comfortably above the resolution boundary on
 * every host the test runner targets. Without this gap two sales
 * created in the same millisecond would tie on `createdAt` and the
 * DESC sort would fall through to the secondary `id` key — which is
 * still deterministic (cuid is monotonic over time) but the spec
 * wording is "ordered by date desc", so making the dates themselves
 * distinct keeps the assertion aligned with the requirement.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fixture: TempDbFixture;
let seed: SeedData;

beforeEach(async () => {
  fixture = await createTempDb();
  seed = await seedFixtureData(fixture);
});

afterEach(async () => {
  await fixture.cleanup();
});

// ---------------------------------------------------------------------------
// CustomerService.detail — history reflects sales (Req 7.3)
// ---------------------------------------------------------------------------

describe('CustomerService.detail — sale history (Req 7.3)', () => {
  it('returns both attached sales ordered by createdAt DESC', async () => {
    // Finalize two sales against the seeded customer. The natural
    // sequencing here makes sale1's createdAt strictly older than
    // sale2's; the sleep guarantees the gap clears SQLite's
    // millisecond resolution so the DESC sort is unambiguous.
    const result1 = await fixture.POSService.finalizeSale(
      makeInput(seed.product.id, seed.customer.id),
      { userId: seed.actor.id },
    );
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;

    await sleep(5);

    const result2 = await fixture.POSService.finalizeSale(
      makeInput(seed.product.id, seed.customer.id),
      { userId: seed.actor.id },
    );
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;

    const sale1 = result1.value;
    const sale2 = result2.value;

    // Drive the real `customer:detail` channel through the service.
    const detail = await fixture.CustomerService.detail({ id: seed.customer.id });

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;

    // (a) The customer payload echoes the seeded record.
    expect(detail.value.customer.id).toBe(seed.customer.id);
    expect(detail.value.customer.name).toBe(seed.customer.name);

    // (b) Both finalized sales appear in the history page.
    const rows = detail.value.history.rows;
    expect(rows).toHaveLength(2);

    // (c) Order is DESC: most recent first. sale2 was finalized
    //     after sale1, so sale2's row is `rows[0]`.
    expect(rows[0]?.id).toBe(sale2.saleId);
    expect(rows[1]?.id).toBe(sale1.saleId);

    // (d) Each row carries the correct serialNo + grandTotal pair.
    //     `grandTotal` is decimal-as-string end-to-end (per
    //     `SaleSummaryDTO`), so `'10'` matches the grand total
    //     produced by `makeInput` after Prisma's Decimal
    //     normalization.
    expect(rows[0]?.serialNo).toBe(sale2.serialNo);
    expect(rows[0]?.grandTotal).toBe('10');
    expect(rows[1]?.serialNo).toBe(sale1.serialNo);
    expect(rows[1]?.grandTotal).toBe('10');

    // (e) Sanity: the DESC ordering also holds on the createdAt
    //     timestamps the rows expose. Strict comparison rather
    //     than `>=` because the 5 ms gap forces distinct values.
    const ts0 = Date.parse(rows[0]?.createdAt ?? '');
    const ts1 = Date.parse(rows[1]?.createdAt ?? '');
    expect(Number.isNaN(ts0)).toBe(false);
    expect(Number.isNaN(ts1)).toBe(false);
    expect(ts0).toBeGreaterThan(ts1);
  });
});
