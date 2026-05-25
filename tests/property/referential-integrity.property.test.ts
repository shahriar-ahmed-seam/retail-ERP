// tests/property/referential-integrity.property.test.ts
//
// Phase 12, task 12.4 — Property 13: referential integrity.
//
// **Validates: Requirement 15.2.**
//
// For every foreign-key pair declared in the prisma schema, the
// property generates a random non-existent foreign id, attempts the
// matching insert, and asserts:
//
//   1. The operation rejects with a Prisma `P2003` error
//      (foreign-key constraint failed). SQLite enforces FK
//      constraints only when `PRAGMA foreign_keys=ON`; the
//      `createTempDb` fixture sets that pragma explicitly so the
//      assertion fires (without it, SQLite silently accepts the
//      insert).
//   2. No row was persisted by the failed insert. We assert this
//      by snapshotting the affected table's row count BEFORE the
//      attempted insert and re-counting AFTER — equality proves no
//      stray row leaked from the rolled-back attempt.
//
// FK pairs covered (sourced from `prisma/schema.prisma` and the
// init migration's `CREATE TABLE` constraints):
//
//   - Product.categoryId            → Category.id
//   - Inventory.productId           → Product.id
//   - SaleItem.productId            → Product.id
//   - SaleItem.saleId               → Sale.id
//   - Payment.saleId                → Sale.id
//   - InventoryMovement.productId   → Product.id
//   - InventoryMovement.userId      → User.id
//   - Sale.cashierId                → User.id
//   - Sale.customerId               → Customer.id (nullable, but a
//                                      non-null bad id still fails)
//   - Purchase.supplierId           → Supplier.id
//   - PurchaseItem.purchaseId       → Purchase.id
//   - PurchaseItem.productId        → Product.id
//   - User.roleId                   → Role.id
//
// **Note on `AuditLog.userId`.** The task description (.kiro
// tasks.md, task 12.4) lists `AuditLog.userId → User.id` as one of
// the FK pairs to cover. The actual Prisma schema
// (`prisma/schema.prisma`) does NOT declare a `@relation` between
// `AuditLog` and `User`, and the generated migration SQL
// (`prisma/migrations/20260524073808_init/migration.sql`) confirms
// there is no `FOREIGN KEY` constraint on `AuditLog.userId`. SQLite
// therefore cannot enforce referential integrity here — a non-null
// `userId` that does not match a real user is silently accepted.
// Including this case in the property test would surface a `no
// error` failure even on the unfixed schema, which is a
// schema-design discussion (whether to add the relation), not a
// referential-integrity bug. The case is omitted with this
// rationale; if the schema gains the relation in a future phase,
// add the case back here.
//
// Strategy notes:
//
//   - Each FK gets its own seeded `validRefs` set so an insert that
//     uses a real id for the OTHER FKs in a multi-FK row (e.g.
//     `SaleItem` needs both a real `saleId` and a real `productId`
//     — the property fuzzes ONE of them at a time) still satisfies
//     the OTHER FKs and the only failing constraint is the one
//     being tested.
//
//   - The "non-existent id" generator uses `fc.uuid({ version: 4 })`
//     so the fast-check seed is deterministic per run. The
//     astronomical improbability of colliding with a real cuid id is
//     ignored — cuid and uuid use distinct alphabets and lengths so
//     a collision is impossible by construction.
//
//   - `numRuns: 30` matches the project-wide convention for
//     DB-backed properties (see
//     `tests/property/sale-totals-identity.property.test.ts`):
//     enough coverage of the id-shape space without hammering
//     SQLite for minutes.
//
//   - `Decimal` columns are filled with `'0'` strings — the
//     property is about referential integrity, not totals
//     correctness. Required string fields are filled with short
//     test values; the test never reads them back.

import { Prisma } from '@prisma/client';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempDb,
  type TempDbFixture,
} from '../integration/fixtures/temp-db.js';

// ---------------------------------------------------------------------------
// Seed shape — references every FK target in the schema
// ---------------------------------------------------------------------------

interface ReferentialSeed {
  readonly roleId: string;
  readonly userId: string;
  readonly categoryId: string;
  readonly productId: string;
  readonly saleId: string;
  readonly customerId: string;
  readonly supplierId: string;
  readonly purchaseId: string;
}

/**
 * Seed every parent-side row this property needs so child-side
 * inserts can target real FK targets for everything EXCEPT the one
 * id under test. Each row uses the smallest valid shape that the
 * Prisma schema accepts.
 */
async function seedReferentialFixtures(
  fixture: TempDbFixture,
): Promise<ReferentialSeed> {
  // Admin role is upserted by `prisma db seed` before
  // `createTempDb` resolves; reuse it.
  const adminRole = await fixture.prisma.role.findUniqueOrThrow({
    where: { name: 'Admin' },
  });

  const user = await fixture.prisma.user.create({
    data: {
      username: 'ref-int-user',
      passwordHash: 'not-a-real-hash',
      roleId: adminRole.id,
    },
  });

  const category = await fixture.prisma.category.create({
    data: { name: 'Ref Int Category' },
  });

  const product = await fixture.prisma.product.create({
    data: {
      sku: 'REF-INT-SKU',
      name: 'Ref Int Product',
      categoryId: category.id,
      buyPrice: '1.00',
      sellPrice: '2.00',
      taxRate: '0',
    },
  });

  // Inventory row needed because some test paths read it; not
  // strictly required by this property but keeps the parent shape
  // consistent with how every other test seeds.
  await fixture.prisma.inventory.create({
    data: { productId: product.id, onHand: 100 },
  });

  const customer = await fixture.prisma.customer.create({
    data: { name: 'Ref Int Customer' },
  });

  const supplier = await fixture.prisma.supplier.create({
    data: { name: 'Ref Int Supplier' },
  });

  // Sale needs a serialNo + cashier + totals. Use a fixed serial
  // number — there is only one sale per test run.
  const sale = await fixture.prisma.sale.create({
    data: {
      serialNo: 'INV-REF-INT',
      cashierId: user.id,
      subtotal: '0',
      discount: '0',
      taxTotal: '0',
      grandTotal: '0',
    },
  });

  const purchase = await fixture.prisma.purchase.create({
    data: { supplierId: supplier.id, total: '0' },
  });

  return {
    roleId: adminRole.id,
    userId: user.id,
    categoryId: category.id,
    productId: product.id,
    saleId: sale.id,
    customerId: customer.id,
    supplierId: supplier.id,
    purchaseId: purchase.id,
  };
}

// ---------------------------------------------------------------------------
// FK case definition
// ---------------------------------------------------------------------------

/**
 * One referential-integrity case. `name` describes the FK pair for
 * test failure output; `tableName` is the SQLite table whose row
 * count we snapshot before/after; `attempt` issues the bad insert
 * and is expected to throw `Prisma.PrismaClientKnownRequestError`
 * with `code: 'P2003'`.
 *
 * The `attempt` callback is a closure over the seeded ids and
 * receives a freshly-generated `badId` per fast-check iteration —
 * the id replaces ONE FK column in the row; every other FK uses a
 * real seeded id so the only failing constraint is the one under
 * test.
 */
interface FkCase {
  readonly name: string;
  readonly tableName: string;
  readonly attempt: (badId: string) => Promise<unknown>;
}

function buildFkCases(
  fixture: TempDbFixture,
  seed: ReferentialSeed,
): readonly FkCase[] {
  const { prisma } = fixture;
  return [
    // Product.categoryId → Category.id
    {
      name: 'Product.categoryId → Category.id',
      tableName: 'Product',
      attempt: (badId) =>
        prisma.product.create({
          data: {
            sku: `bad-cat-${badId}`,
            name: 'Bad Category Ref',
            categoryId: badId,
            buyPrice: '0',
            sellPrice: '0',
            taxRate: '0',
          },
        }),
    },
    // Inventory.productId → Product.id
    {
      name: 'Inventory.productId → Product.id',
      tableName: 'Inventory',
      attempt: (badId) =>
        prisma.inventory.create({
          data: { productId: badId, onHand: 0 },
        }),
    },
    // SaleItem.productId → Product.id (saleId real)
    {
      name: 'SaleItem.productId → Product.id',
      tableName: 'SaleItem',
      attempt: (badId) =>
        prisma.saleItem.create({
          data: {
            saleId: seed.saleId,
            productId: badId,
            quantity: 1,
            unitPrice: '0',
            taxRate: '0',
            lineTotal: '0',
          },
        }),
    },
    // SaleItem.saleId → Sale.id (productId real)
    {
      name: 'SaleItem.saleId → Sale.id',
      tableName: 'SaleItem',
      attempt: (badId) =>
        prisma.saleItem.create({
          data: {
            saleId: badId,
            productId: seed.productId,
            quantity: 1,
            unitPrice: '0',
            taxRate: '0',
            lineTotal: '0',
          },
        }),
    },
    // Payment.saleId → Sale.id
    {
      name: 'Payment.saleId → Sale.id',
      tableName: 'Payment',
      attempt: (badId) =>
        prisma.payment.create({
          data: { saleId: badId, method: 'cash', amount: '0' },
        }),
    },
    // InventoryMovement.productId → Product.id (userId real)
    {
      name: 'InventoryMovement.productId → Product.id',
      tableName: 'InventoryMovement',
      attempt: (badId) =>
        prisma.inventoryMovement.create({
          data: {
            productId: badId,
            quantityDelta: 1,
            movementType: 'adjustment',
            referenceType: 'adjustment',
            referenceId: 'no-such-ref',
            userId: seed.userId,
          },
        }),
    },
    // Sale.cashierId → User.id (customerId null is fine)
    {
      name: 'Sale.cashierId → User.id',
      tableName: 'Sale',
      attempt: (badId) =>
        prisma.sale.create({
          data: {
            // Fresh serialNo per attempt to avoid colliding with
            // the seeded sale's unique constraint masking the FK
            // failure (a P2002 ahead of P2003 would defeat the
            // assertion).
            serialNo: `INV-BAD-CASHIER-${badId.slice(0, 12)}`,
            cashierId: badId,
            subtotal: '0',
            discount: '0',
            taxTotal: '0',
            grandTotal: '0',
          },
        }),
    },
    // Sale.customerId → Customer.id (nullable; non-null bad id still fails)
    {
      name: 'Sale.customerId → Customer.id',
      tableName: 'Sale',
      attempt: (badId) =>
        prisma.sale.create({
          data: {
            serialNo: `INV-BAD-CUST-${badId.slice(0, 12)}`,
            customerId: badId,
            cashierId: seed.userId,
            subtotal: '0',
            discount: '0',
            taxTotal: '0',
            grandTotal: '0',
          },
        }),
    },
    // Purchase.supplierId → Supplier.id
    {
      name: 'Purchase.supplierId → Supplier.id',
      tableName: 'Purchase',
      attempt: (badId) =>
        prisma.purchase.create({
          data: { supplierId: badId, total: '0' },
        }),
    },
    // PurchaseItem.purchaseId → Purchase.id (productId real)
    {
      name: 'PurchaseItem.purchaseId → Purchase.id',
      tableName: 'PurchaseItem',
      attempt: (badId) =>
        prisma.purchaseItem.create({
          data: {
            purchaseId: badId,
            productId: seed.productId,
            quantity: 1,
            unitBuyPrice: '0',
            lineTotal: '0',
          },
        }),
    },
    // PurchaseItem.productId → Product.id (purchaseId real)
    {
      name: 'PurchaseItem.productId → Product.id',
      tableName: 'PurchaseItem',
      attempt: (badId) =>
        prisma.purchaseItem.create({
          data: {
            purchaseId: seed.purchaseId,
            productId: badId,
            quantity: 1,
            unitBuyPrice: '0',
            lineTotal: '0',
          },
        }),
    },
    // User.roleId → Role.id
    {
      name: 'User.roleId → Role.id',
      tableName: 'User',
      attempt: (badId) =>
        prisma.user.create({
          data: {
            username: `bad-role-${badId.slice(0, 12)}`,
            passwordHash: 'not-real',
            roleId: badId,
          },
        }),
    },
    // AuditLog.userId → User.id is INTENTIONALLY OMITTED — see
    // the file header. The schema does not declare this relation
    // and the migration has no `FOREIGN KEY` for `AuditLog.userId`,
    // so SQLite cannot enforce it; including the case would surface
    // as a schema-design issue, not a referential-integrity bug.
    // InventoryMovement.userId → User.id (productId real) — bonus
    // FK that is structurally identical to the others and worth
    // covering since `InventoryMovement` carries TWO FKs.
    {
      name: 'InventoryMovement.userId → User.id',
      tableName: 'InventoryMovement',
      attempt: (badId) =>
        prisma.inventoryMovement.create({
          data: {
            productId: seed.productId,
            quantityDelta: 1,
            movementType: 'adjustment',
            referenceType: 'adjustment',
            referenceId: 'no-such-ref',
            userId: badId,
          },
        }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Per-table row-count helper
// ---------------------------------------------------------------------------

/**
 * Read the row count for a SQLite table by name. Used to snapshot
 * before/after the attempted insert so we can prove no row was
 * persisted.
 *
 * `$queryRawUnsafe` is fine here because every `tableName` is a
 * hard-coded literal from `buildFkCases` — there is no user input
 * threading through this query.
 */
async function countTableRows(
  fixture: TempDbFixture,
  tableName: string,
): Promise<number> {
  const rows = await fixture.prisma.$queryRawUnsafe<readonly { count: number | bigint }[]>(
    `SELECT COUNT(*) AS count FROM "${tableName}"`,
  );
  const first = rows[0];
  if (first === undefined) return 0;
  // SQLite COUNT can come back as a `bigint` depending on driver
  // settings; coerce to number — every count we read is well below
  // `Number.MAX_SAFE_INTEGER`.
  return typeof first.count === 'bigint' ? Number(first.count) : first.count;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fixture: TempDbFixture;
let seed: ReferentialSeed;
let cases: readonly FkCase[];

beforeEach(async () => {
  fixture = await createTempDb();
  seed = await seedReferentialFixtures(fixture);
  cases = buildFkCases(fixture, seed);
});

afterEach(async () => {
  await fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Property 13 — referential integrity
// ---------------------------------------------------------------------------

describe('Property 13 — referential integrity', () => {
  it(
    'every FK pair: insert with non-existent foreign id is rejected with P2003 and persists nothing',
    async () => {
      // Per the project convention for DB-backed properties: 30
      // iterations spans the random-id space comfortably without
      // hammering SQLite. Each iteration walks every FK case in the
      // schema, so the (case × iteration) grid is dense.
      await fc.assert(
        fc.asyncProperty(fc.uuid({ version: 4 }), async (badId) => {
          // Walk every FK case for this generated bad id. Each case
          // snapshots its target table's row count, attempts the
          // insert, asserts the throw shape, and re-counts to prove
          // no row was persisted.
          for (const fkCase of cases) {
            const before = await countTableRows(fixture, fkCase.tableName);

            let thrown: unknown = null;
            try {
              await fkCase.attempt(badId);
            } catch (err) {
              thrown = err;
            }

            // 1. Operation rejected with Prisma's P2003 (FK
            // constraint failed). The fixture's
            // `PRAGMA foreign_keys=ON` is what makes this fire —
            // without it SQLite would silently accept the bad
            // insert.
            if (
              !(thrown instanceof Prisma.PrismaClientKnownRequestError) ||
              thrown.code !== 'P2003'
            ) {
              const detail =
                thrown === null
                  ? 'no error'
                  : thrown instanceof Error
                    ? `${thrown.name}: ${thrown.message}`
                    : 'unknown';
              throw new Error(
                `[Property 13] ${fkCase.name}: expected P2003 foreign-key violation, got ${detail}`,
              );
            }

            // 2. No row persisted by the failed insert. SQLite
            // rolls back the implicit transaction the create issued,
            // so the table count is unchanged.
            const after = await countTableRows(fixture, fkCase.tableName);
            expect(
              after,
              `[Property 13] ${fkCase.name}: row count grew from ${before} to ${after}`,
            ).toBe(before);
          }
        }),
        { numRuns: 30 },
      );
    },
    // 30 iterations × ~14 FK cases × (insert attempt + 2 counts) is
    // dominated by SQLite write-ahead log overhead. Allow 60s for
    // headroom on cold-cache CI runs.
    60_000,
  );
});
