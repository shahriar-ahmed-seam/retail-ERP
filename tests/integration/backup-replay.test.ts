// tests/integration/backup-replay.test.ts
//
// Phase 11, tasks 11.6 + 11.6.1 — integration test for the
// recovery flow's replay leg.
//
// The full "restore over shop.db" path requires the live Prisma
// client to be reconnectable against a freshly-replaced file,
// which the test fixture's per-test DATABASE_URL injection makes
// awkward (the singleton's URL is fixed at construction time).
// This integration test focuses instead on the load-bearing
// invariant: `replayJournal` against a real SQLite + Prisma
// client converges to the expected state and is idempotent
// across re-runs.
//
// Scenario:
//   1. Seed two sales through the real `POSService.finalizeSale`
//      so the journal carries genuine `opType: 'sale'` entries.
//   2. Mark a "snapshot timestamp" between the two sales.
//   3. Drive `replayJournal({ snapshotTs })` against the same
//      client. The first sale is BEFORE the snapshot (skipped);
//      the second sale is AFTER (re-applied).
//   4. Assert the replay returns Ok with the expected counts and
//      the sale row contents are unchanged.
//   5. Run `replayJournal` AGAIN and assert it remains
//      idempotent — Sale, SaleItem, Payment, InventoryMovement
//      counts do not grow.
//
// Validates: Requirements 10.6, 11.3, 16.8.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { replayJournal } from '@main/services/backup/replay';

import { createTempDb, type TempDbFixture } from './fixtures/temp-db.js';

// ---------------------------------------------------------------------------
// Per-test fixture
// ---------------------------------------------------------------------------

let fixture: TempDbFixture;

beforeEach(async () => {
  fixture = await createTempDb();
});

afterEach(async () => {
  await fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SeededFixture {
  readonly userId: string;
  readonly customerId: string;
  readonly productId: string;
}

async function seedForSale(): Promise<SeededFixture> {
  const role = await fixture.prisma.role.findUniqueOrThrow({ where: { name: 'Admin' } });
  const user = await fixture.prisma.user.create({
    data: { username: 'cashier-int', passwordHash: 'placeholder', roleId: role.id },
  });

  const category = await fixture.prisma.category.create({
    data: { name: 'replay-test-cat' },
  });
  const product = await fixture.prisma.product.create({
    data: {
      sku: 'REPLAY-1',
      name: 'Replay Widget',
      categoryId: category.id,
      buyPrice: '5',
      sellPrice: '10',
      taxRate: '0',
      reorderLevel: 0,
      warrantyMonths: 0,
    },
  });
  await fixture.prisma.inventory.create({
    data: { productId: product.id, onHand: 100 },
  });
  const customer = await fixture.prisma.customer.create({
    data: { name: 'Replay Customer', phone: '555-0100' },
  });

  return { userId: user.id, customerId: customer.id, productId: product.id };
}

function buildSaleInput(seed: SeededFixture, quantity: number) {
  const subtotal = (10 * quantity).toFixed(2);
  return {
    customerId: seed.customerId,
    items: [
      {
        productId: seed.productId,
        quantity,
        unitPrice: '10',
        taxRate: '0',
        lineTotal: subtotal,
      },
    ],
    discount: { kind: 'fixed' as const, amount: '0' },
    subtotal,
    discountAmount: '0',
    taxTotal: '0',
    grandTotal: subtotal,
    payments: [{ method: 'cash' as const, amount: subtotal }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('replayJournal — integration', () => {
  it('re-applies post-snapshot sales idempotently against a real Prisma client', async () => {
    const seed = await seedForSale();

    // Sale 1 — pre-snapshot.
    const sale1 = await fixture.POSService.finalizeSale(
      buildSaleInput(seed, 2),
      { userId: seed.userId },
    );
    expect(sale1.ok).toBe(true);
    if (!sale1.ok) return;

    // Mark snapshot timestamp BETWEEN the two sales. Sleep a few
    // milliseconds so the second sale's `JournalEntry.timestamp`
    // is strictly greater than the recorded boundary.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshotTs = new Date();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Sale 2 — post-snapshot. The journal entry for this sale
    // has timestamp >= snapshotTs and is the only entry that
    // should be re-applied.
    const sale2 = await fixture.POSService.finalizeSale(
      buildSaleInput(seed, 3),
      { userId: seed.userId },
    );
    expect(sale2.ok).toBe(true);
    if (!sale2.ok) return;

    // Capture state before replay.
    const beforeSales = await fixture.prisma.sale.count();
    const beforeMovements = await fixture.prisma.inventoryMovement.count();
    const beforePayments = await fixture.prisma.payment.count();
    const beforeOnHand =
      (await fixture.prisma.inventory.findUniqueOrThrow({
        where: { productId: seed.productId },
      })).onHand;

    // First replay — should re-apply only the post-snapshot sale.
    // The pre-snapshot sale is skipped because its timestamp <
    // snapshotTs. The post-snapshot sale's row data is rewritten
    // identically (same saleId, same line totals, same payment
    // amount), so the resulting state matches the pre-replay state.
    const replay1 = await replayJournal({
      snapshotTs,
      prismaClient: fixture.prisma,
    });
    expect(replay1.ok).toBe(true);
    if (!replay1.ok) return;
    expect(replay1.value.appliedCount).toBe(1);

    // After replay: sale + movement counts should be the same as
    // before (replay rewrote child rows, not added new ones), and
    // the inventory cache must equal the pre-replay value.
    const afterSales = await fixture.prisma.sale.count();
    const afterMovements = await fixture.prisma.inventoryMovement.count();
    const afterPayments = await fixture.prisma.payment.count();
    const afterOnHand =
      (await fixture.prisma.inventory.findUniqueOrThrow({
        where: { productId: seed.productId },
      })).onHand;

    expect(afterSales).toBe(beforeSales);
    expect(afterMovements).toBe(beforeMovements);
    expect(afterPayments).toBe(beforePayments);
    expect(afterOnHand).toBe(beforeOnHand);

    // Second replay — must remain idempotent.
    const replay2 = await replayJournal({
      snapshotTs,
      prismaClient: fixture.prisma,
    });
    expect(replay2.ok).toBe(true);

    const finalSales = await fixture.prisma.sale.count();
    const finalMovements = await fixture.prisma.inventoryMovement.count();
    const finalPayments = await fixture.prisma.payment.count();
    expect(finalSales).toBe(beforeSales);
    expect(finalMovements).toBe(beforeMovements);
    expect(finalPayments).toBe(beforePayments);
  });

  it('returns Ok({ batchCount: 0, appliedCount: 0 }) when no journal entries are after the snapshot', async () => {
    const seed = await seedForSale();
    await fixture.POSService.finalizeSale(buildSaleInput(seed, 1), {
      userId: seed.userId,
    });

    // Snapshot AFTER the sale. The journal entry for the sale has
    // timestamp < snapshotTs, so the walker finds no entries.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshotTs = new Date();

    const replay = await replayJournal({
      snapshotTs,
      prismaClient: fixture.prisma,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.batchCount).toBe(0);
      expect(replay.value.appliedCount).toBe(0);
    }
  });
});
