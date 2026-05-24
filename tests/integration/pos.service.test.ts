// tests/integration/pos.service.test.ts
//
// Phase 9, task 9.3 — Integration test for the customer-attach
// finalize flow.
//
// Drives the real `POSService.finalizeSale` against a per-test
// SQLite database (via the `temp-db` fixture) and asserts the
// `Sale.customerId` column carries the renderer-supplied customer
// id (or `null` for walk-in sales). Three tests:
//
//   1. Walk-in sale (`customerId: null`): the persisted `Sale` row
//      stores `customerId = null` and `customer = null`.
//
//   2. Attached sale (`customerId: '<existing-id>'`): the persisted
//      `Sale` row stores the supplied customer id; the joined
//      customer name shows up in the returned DTO; the customer's
//      sale-history view (via the `customerId` index) finds the row.
//
//   3. FK_VIOLATION on unknown customer id: the transaction is
//      rolled back; nothing is persisted.
//
// These assertions are at the service level because customer
// attachment is a service-level invariant (Req 7.2, 7.4). The IPC
// router adds permission and audit middleware on top but it does
// not alter the persisted column.
//
// Validates: Requirements 7.2, 7.4.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDb, type TempDbFixture } from './fixtures/temp-db.js';

import type { FinalizeSaleInput } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Per-test seed shape
// ---------------------------------------------------------------------------

/**
 * Minimum business set the POS service touches:
 *   - one `Cashier` user as the actor (`ctx.userId`),
 *   - one product with onHand 5 so the single-line sale below has
 *     stock to draw from,
 *   - one customer the attach flow can target,
 *   - the `sale.serialCounter` setting comes from the seed.
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
      sku: 'SKU-CUST',
      name: 'Test Item',
      categoryId: category.id,
      buyPrice: '5.00',
      sellPrice: '10.00',
      taxRate: '0',
    },
  });

  // Inventory row at onHand: 5 — a single-line sale of quantity 1
  // commits without OOS.
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

/**
 * Build a one-line, one-payment finalize input that satisfies the
 * totals identity: `1 × 10.00, taxRate 0, no discount → grand 10`.
 * The optional `customerId` overlays the walk-in default.
 */
function makeInput(
  productId: string,
  customerId: string | null,
): FinalizeSaleInput {
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
// Walk-in sale: customerId = null (Req 7.4)
// ---------------------------------------------------------------------------

describe('POSService.finalizeSale — walk-in sale (Req 7.4)', () => {
  it('persists Sale.customerId as null when no customer is attached', async () => {
    const result = await fixture.POSService.finalizeSale(
      makeInput(seed.product.id, null),
      { userId: seed.actor.id },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Returned DTO shows a walk-in sale.
    expect(result.value.sale.customerId).toBeNull();
    expect(result.value.sale.customerName).toBeNull();

    // Persisted row matches.
    const sales = await fixture.prisma.sale.findMany();
    expect(sales).toHaveLength(1);
    expect(sales[0]!.customerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Attached sale: customerId = '<existing-id>' (Req 7.2)
// ---------------------------------------------------------------------------

describe('POSService.finalizeSale — customer attached (Req 7.2)', () => {
  it('persists Sale.customerId on the row and projects the customer name onto the DTO', async () => {
    const result = await fixture.POSService.finalizeSale(
      makeInput(seed.product.id, seed.customer.id),
      { userId: seed.actor.id },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Returned DTO carries the attached customer.
    expect(result.value.sale.customerId).toBe(seed.customer.id);
    expect(result.value.sale.customerName).toBe(seed.customer.name);

    // Persisted row carries the same id.
    const sales = await fixture.prisma.sale.findMany();
    expect(sales).toHaveLength(1);
    expect(sales[0]!.customerId).toBe(seed.customer.id);

    // The `(customerId)` index makes this lookup a seek, not a
    // scan; the row count is the assertion that matters here.
    const customerSales = await fixture.prisma.sale.findMany({
      where: { customerId: seed.customer.id },
    });
    expect(customerSales).toHaveLength(1);
    expect(customerSales[0]!.id).toBe(result.value.saleId);
  });
});

// ---------------------------------------------------------------------------
// Unknown customer id rolls the whole transaction back (defence-in-depth)
// ---------------------------------------------------------------------------

describe('POSService.finalizeSale — unknown customerId rolls back', () => {
  it('returns Err(FK_VIOLATION) and persists nothing', async () => {
    // Capture baseline counts so the rollback assertion is robust to
    // any future seed changes.
    const baselineSaleCount = await fixture.prisma.sale.count();
    const baselineMovementCount =
      await fixture.prisma.inventoryMovement.count();
    const baselineJournalCount = await fixture.prisma.journalEntry.count();

    const result = await fixture.POSService.finalizeSale(
      makeInput(seed.product.id, 'c-does-not-exist'),
      { userId: seed.actor.id },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FK_VIOLATION');
    expect(result.error.details).toEqual({ reason: 'not_found' });

    // Nothing persisted.
    expect(await fixture.prisma.sale.count()).toBe(baselineSaleCount);
    expect(await fixture.prisma.inventoryMovement.count()).toBe(
      baselineMovementCount,
    );
    expect(await fixture.prisma.journalEntry.count()).toBe(baselineJournalCount);

    // Inventory unchanged.
    const inventory = await fixture.prisma.inventory.findUniqueOrThrow({
      where: { productId: seed.product.id },
    });
    expect(inventory.onHand).toBe(5);
  });
});
