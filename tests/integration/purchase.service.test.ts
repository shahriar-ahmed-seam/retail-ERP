// tests/integration/purchase.service.test.ts
//
// Phase 6, task 6.4 — Integration test for purchase atomicity.
//
// Runs the real `PurchaseService.create` against a per-test SQLite
// database (via the `temp-db` fixture). Two tests:
//
//   1. Happy path: a valid two-line purchase commits the full set of
//      paired writes atomically — header + items + ledger movements +
//      journal — and updates `Inventory.onHand` for both products.
//
//   2. Atomicity / rollback: a purchase whose second line references
//      a non-existent productId fails with `Err('FK_VIOLATION', {
//      reason: 'not_found' })` and persists NOTHING — no purchase
//      header, no items, no inventory movement (the first line's
//      would-be increment is rolled back), no journal row. This is
//      the "Property 6 partial coverage" the task description calls
//      out: design.md > "Atomicity boundaries" requires that any
//      failure inside the `$transaction` block roll the entire
//      operation back.
//
// The test calls `PurchaseService.create` directly because
// atomicity is a service-level invariant (Req 5.5, 11.2). The IPC
// router adds permission and audit middleware on top but it does not
// alter the transactional shape.
//
// Validates: Requirements 5.1, 5.5, 11.2.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDb, type TempDbFixture } from './fixtures/temp-db.js';

// ---------------------------------------------------------------------------
// Per-test seed shape
// ---------------------------------------------------------------------------

/**
 * What `seedFixtureData` returns to the test. The shape mirrors the
 * minimum business set the purchase service touches:
 *   - one `Admin` user as the actor (`ctx.userId`),
 *   - one supplier referenced by the purchase header,
 *   - two products referenced by the two lines, each with a
 *     pre-created inventory row at `onHand: 0`.
 */
interface SeedData {
  readonly actor: { id: string; username: string };
  readonly supplier: { id: string; name: string };
  readonly productA: { id: string; sku: string };
  readonly productB: { id: string; sku: string };
}

/**
 * Seed the per-test DB with exactly the rows `PurchaseService.create`
 * needs to find. Uses the fixture's Prisma client directly — services
 * that create these rows (auth, supplier, product) belong to other
 * phases and bringing them in here would couple this test to their
 * surface.
 *
 * The Admin role is upserted by `prisma db seed` before the fixture
 * returns, so `findUniqueOrThrow({ name: 'Admin' })` is safe.
 *
 * Inventory rows are explicitly written at `onHand: 0` so the
 * atomicity assertion ("Inventory.onHand for product A is still 0")
 * has a known baseline. `ProductService.upsert` would also create
 * them, but inlining the writes here keeps the test self-contained.
 */
async function seedFixtureData(fixture: TempDbFixture): Promise<SeedData> {
  const adminRole = await fixture.prisma.role.findUniqueOrThrow({
    where: { name: 'Admin' },
  });

  const actor = await fixture.prisma.user.create({
    data: {
      username: 'test-admin',
      // Hash is irrelevant — this test never goes through AuthService.
      // Storing a plain placeholder keeps the test fast and removes a
      // bcrypt dependency from this file.
      passwordHash: 'test-not-a-real-hash',
      roleId: adminRole.id,
    },
  });

  const supplier = await fixture.prisma.supplier.create({
    data: { name: 'Test Supplier Inc.' },
  });

  // Two distinct categories so the product create paths are independent.
  const categoryA = await fixture.prisma.category.create({
    data: { name: 'Category A' },
  });
  const categoryB = await fixture.prisma.category.create({
    data: { name: 'Category B' },
  });

  const productA = await fixture.prisma.product.create({
    data: {
      sku: 'SKU-A',
      name: 'Product A',
      categoryId: categoryA.id,
      buyPrice: '8.00',
      sellPrice: '12.00',
    },
  });
  const productB = await fixture.prisma.product.create({
    data: {
      sku: 'SKU-B',
      name: 'Product B',
      categoryId: categoryB.id,
      buyPrice: '5.00',
      sellPrice: '8.00',
    },
  });

  // Inventory rows at onHand: 0 — explicit baseline for the atomicity
  // assertion. `applyMovement` reads these via `findUniqueOrThrow` and
  // would throw P2025 (mapped to FK_VIOLATION) if they were missing.
  await fixture.prisma.inventory.create({
    data: { productId: productA.id, onHand: 0 },
  });
  await fixture.prisma.inventory.create({
    data: { productId: productB.id, onHand: 0 },
  });

  return {
    actor: { id: actor.id, username: actor.username },
    supplier: { id: supplier.id, name: supplier.name },
    productA: { id: productA.id, sku: productA.sku },
    productB: { id: productB.id, sku: productB.sku },
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
// Happy path
// ---------------------------------------------------------------------------

describe('PurchaseService.create — happy path', () => {
  it('persists header + items + movements + journal atomically and updates inventory', async () => {
    // Two lines: 5 × 10.00 + 3 × 7.50 = 50 + 22.5 = 72.5 expected total.
    // Decimal arithmetic is intentional — `Prisma.Decimal('72.50').toString()`
    // produces the canonical `72.5` (trailing zero dropped) so we
    // assert against that form below.
    const result = await fixture.PurchaseService.create(
      {
        supplierId: seed.supplier.id,
        items: [
          { productId: seed.productA.id, quantity: 5, unitBuyPrice: '10.00' },
          { productId: seed.productB.id, quantity: 3, unitBuyPrice: '7.50' },
        ],
      },
      { userId: seed.actor.id },
    );

    // (a) Service returns Ok({ purchaseId }).
    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrow
    const purchaseId = result.value.purchaseId;
    expect(typeof purchaseId).toBe('string');
    expect(purchaseId.length).toBeGreaterThan(0);

    // (b) Exactly one Purchase row, correct supplier, total 72.5.
    const purchases = await fixture.prisma.purchase.findMany();
    expect(purchases).toHaveLength(1);
    const purchase = purchases[0]!;
    expect(purchase.id).toBe(purchaseId);
    expect(purchase.supplierId).toBe(seed.supplier.id);
    // Prisma.Decimal canonicalizes `72.50` as `72.5` (trailing zero
    // dropped). The test asserts against the canonical string so a
    // future schema change to a fixed-precision type would still pass
    // — the renderer wires up via `toString()` everywhere.
    expect(purchase.total.toString()).toBe('72.5');

    // (c) Two PurchaseItem rows with the expected per-line numbers.
    // Order by quantity DESC so we can match A first (quantity 5)
    // then B (quantity 3) regardless of physical insert order.
    const items = await fixture.prisma.purchaseItem.findMany({
      where: { purchaseId },
      orderBy: { quantity: 'desc' },
    });
    expect(items).toHaveLength(2);

    const itemA = items[0]!;
    expect(itemA.productId).toBe(seed.productA.id);
    expect(itemA.quantity).toBe(5);
    expect(itemA.unitBuyPrice.toString()).toBe('10');
    expect(itemA.lineTotal.toString()).toBe('50');

    const itemB = items[1]!;
    expect(itemB.productId).toBe(seed.productB.id);
    expect(itemB.quantity).toBe(3);
    expect(itemB.unitBuyPrice.toString()).toBe('7.5');
    expect(itemB.lineTotal.toString()).toBe('22.5');

    // (d) Two InventoryMovement rows, both `purchase`-flavoured,
    // referencing this purchaseId, signed by the actor, with matching
    // positive deltas.
    const movements = await fixture.prisma.inventoryMovement.findMany({
      where: { referenceId: purchaseId },
      orderBy: { quantityDelta: 'desc' },
    });
    expect(movements).toHaveLength(2);

    const movementA = movements[0]!;
    expect(movementA.productId).toBe(seed.productA.id);
    expect(movementA.quantityDelta).toBe(5);
    expect(movementA.movementType).toBe('purchase');
    expect(movementA.referenceType).toBe('purchase');
    expect(movementA.referenceId).toBe(purchaseId);
    expect(movementA.userId).toBe(seed.actor.id);

    const movementB = movements[1]!;
    expect(movementB.productId).toBe(seed.productB.id);
    expect(movementB.quantityDelta).toBe(3);
    expect(movementB.movementType).toBe('purchase');
    expect(movementB.referenceType).toBe('purchase');
    expect(movementB.referenceId).toBe(purchaseId);
    expect(movementB.userId).toBe(seed.actor.id);

    // (e) Inventory.onHand reflects the increments exactly.
    const inventoryA = await fixture.prisma.inventory.findUniqueOrThrow({
      where: { productId: seed.productA.id },
    });
    expect(inventoryA.onHand).toBe(5);
    const inventoryB = await fixture.prisma.inventory.findUniqueOrThrow({
      where: { productId: seed.productB.id },
    });
    expect(inventoryB.onHand).toBe(3);

    // (f) Exactly one JournalEntry of opType `purchase`, with a
    // payload that round-trips through JSON.parse and contains the
    // replay-relevant fields. The shape comes from
    // `purchase.service.ts` step 4 of the transaction.
    const journals = await fixture.prisma.journalEntry.findMany({
      where: { opType: 'purchase' },
    });
    expect(journals).toHaveLength(1);
    const journal = journals[0]!;
    const payload = JSON.parse(journal.payload) as {
      purchaseId?: unknown;
      supplierId?: unknown;
      total?: unknown;
      items?: unknown;
      userId?: unknown;
    };
    expect(payload.purchaseId).toBe(purchaseId);
    expect(payload.supplierId).toBe(seed.supplier.id);
    // Total is stringified in the payload so it round-trips JSON
    // without precision loss — same canonicalization as the row
    // column above.
    expect(payload.total).toBe('72.5');
    expect(payload.userId).toBe(seed.actor.id);
    expect(Array.isArray(payload.items)).toBe(true);
    const journalItems = payload.items as {
      productId: string;
      quantity: number;
      unitBuyPrice: string;
      lineTotal: string;
    }[];
    expect(journalItems).toHaveLength(2);
    // Ordered as the input was — the service preserves input order.
    expect(journalItems[0]!.productId).toBe(seed.productA.id);
    expect(journalItems[0]!.quantity).toBe(5);
    expect(journalItems[0]!.unitBuyPrice).toBe('10');
    expect(journalItems[0]!.lineTotal).toBe('50');
    expect(journalItems[1]!.productId).toBe(seed.productB.id);
    expect(journalItems[1]!.quantity).toBe(3);
    expect(journalItems[1]!.unitBuyPrice).toBe('7.5');
    expect(journalItems[1]!.lineTotal).toBe('22.5');
  });
});

// ---------------------------------------------------------------------------
// Atomicity / rollback (Property 6 partial coverage)
// ---------------------------------------------------------------------------

describe('PurchaseService.create — atomicity', () => {
  it('rolls back every write when one line references a non-existent product', async () => {
    // Capture the row counts BEFORE the failing call so the
    // assertions can compare against the exact baseline. The seed
    // wrote zero of each of these models, but reading the baseline
    // explicitly makes the test resilient to any future seed change.
    const baselinePurchaseCount = await fixture.prisma.purchase.count();
    const baselinePurchaseItemCount = await fixture.prisma.purchaseItem.count();
    const baselineMovementCount = await fixture.prisma.inventoryMovement.count();
    const baselineJournalCount = await fixture.prisma.journalEntry.count();
    const baselineInventoryA = await fixture.prisma.inventory.findUniqueOrThrow({
      where: { productId: seed.productA.id },
    });
    expect(baselinePurchaseCount).toBe(0);
    expect(baselinePurchaseItemCount).toBe(0);
    expect(baselineMovementCount).toBe(0);
    expect(baselineJournalCount).toBe(0);
    expect(baselineInventoryA.onHand).toBe(0);

    // Two lines: line 1 valid, line 2 references a productId that
    // does not exist. The service walks the lines in order, so by
    // the time the second line's `applyMovement` throws (P2025 from
    // `findUniqueOrThrow` on the missing inventory row), the first
    // line has already created its PurchaseItem and InventoryMovement
    // rows AND incremented `Inventory.onHand` for product A. The
    // transaction rollback is the only thing that prevents the
    // partial write from persisting.
    const result = await fixture.PurchaseService.create(
      {
        supplierId: seed.supplier.id,
        items: [
          { productId: seed.productA.id, quantity: 1, unitBuyPrice: '5.00' },
          { productId: 'product-does-not-exist', quantity: 1, unitBuyPrice: '5.00' },
        ],
      },
      { userId: seed.actor.id },
    );

    // (a) Service returns Err('FK_VIOLATION', { reason: 'not_found' }).
    // Both Prisma error codes (P2003 raw FK violation, P2025
    // findUniqueOrThrow miss) map to this single envelope per
    // purchase.service.ts. The exact mapping is what makes the
    // renderer able to show "supplier or product not found" without
    // branching on the underlying cause.
    expect(result.ok).toBe(false);
    if (result.ok) return; // type narrow
    expect(result.error.code).toBe('FK_VIOLATION');
    expect(result.error.details).toEqual({ reason: 'not_found' });

    // (b) NOTHING was persisted. Each model's row count is unchanged
    // from the baseline. This is the load-bearing assertion of the
    // task — Req 5.5 / 11.2: the four writes either all commit
    // together or none of them do.
    expect(await fixture.prisma.purchase.count()).toBe(baselinePurchaseCount);
    expect(await fixture.prisma.purchaseItem.count()).toBe(baselinePurchaseItemCount);
    expect(await fixture.prisma.inventoryMovement.count()).toBe(baselineMovementCount);
    expect(await fixture.prisma.journalEntry.count()).toBe(baselineJournalCount);

    // (c) Inventory.onHand for product A is still 0 — the rolled-back
    // movement's increment is gone. This is the strongest possible
    // proof that step 3 of the transaction (applyMovement, which
    // updates Inventory.onHand AND inserts the movement row) was
    // also unwound. Without rollback we would observe `onHand === 1`
    // here even with zero movement rows, because Inventory and
    // InventoryMovement live in two different tables.
    const inventoryAAfter = await fixture.prisma.inventory.findUniqueOrThrow({
      where: { productId: seed.productA.id },
    });
    expect(inventoryAAfter.onHand).toBe(0);
  });
});
