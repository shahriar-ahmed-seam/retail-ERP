// tests/property/fixtures/pos-seed.ts
//
// Shared 5-product universe seeded into the per-test SQLite for POS
// property tests (Phase 7).
//
// Why this lives here: Property 2 (sale totals identity, task 7.7)
// and Property 8 (tax on post-discount subtotal, task 7.9) both
// generate carts against the same diverse product set — varied
// `sellPrice` and varied `taxRate` (including 0 for the fast-path
// branch in `computeTaxTotal`). Duplicating the seed across two
// files would add ~70 lines of identical code; this module is the
// extraction point.
//
// Property 4 (monotonic, unique sale serials, task 7.8) does NOT
// use this helper — it only needs a single product (the property is
// about the serial allocator, not the cart shape). Property 4 keeps
// its own one-line seed inline.
//
// The helper takes a `TempDbFixture` (see
// `tests/integration/fixtures/temp-db.ts`) so the writes go through
// the SAME per-test Prisma singleton the property test will read
// from later. Inventory is seeded at `HIGH_ONHAND` (1_000_000) so
// the carts the generators produce never trip the out-of-stock
// branch — Property 3 (Phase 5, task 5.6) covers underflow
// separately.

import type { TempDbFixture } from '../../integration/fixtures/temp-db.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * One product as seeded into the per-test DB. Carries the `sellPrice`
 * and `taxRate` strings the generator needs to compute totals
 * self-consistently with `@shared/pos-totals` — no need to re-read
 * the row.
 */
export interface SeededProduct {
  readonly id: string;
  readonly sellPrice: string;
  readonly taxRate: string;
}

/**
 * What `seedProductUniverse` returns. Tests use `actor.id` as the
 * `userId` ctx for `finalizeSale`, `supplierId` is included in case
 * a future POS property test needs to record purchases against the
 * same products, and `products` is the universe the cart generator
 * picks from.
 */
export interface SeedData {
  readonly actor: { id: string };
  readonly supplierId: string;
  readonly products: readonly SeededProduct[];
}

/**
 * Five products tuned to surface the POS properties' edge cases:
 *
 *   - `T-0`     : tax-free, cheap. The "no tax line" branch in
 *                 `computeTaxTotal` (Property 8 fast-path).
 *   - `T-5`     : 5% tax, mid-price. Common low-tax case.
 *   - `T-18`    : 18% tax, mid-price. Common high-tax case.
 *   - `T-MIX-A` : 18% tax with a non-round price (`12.34`). Exercises
 *                 the proportional-discount allocation against an
 *                 irrational-ish factor.
 *   - `T-MIX-B` : 5% tax with a non-round price (`7.89`). Pairs with
 *                 `T-MIX-A` so a multi-line cart hits two tax rates
 *                 at once.
 *
 * Exposed publicly so a property test can index into it for an
 * "every product is tax-free" edge-case assertion (Property 8) or
 * pin a specific shape inline.
 */
export const PRODUCT_SHAPES: readonly { sellPrice: string; taxRate: string; sku: string }[] = [
  { sku: 'T-0', sellPrice: '5.00', taxRate: '0' },
  { sku: 'T-5', sellPrice: '15.00', taxRate: '0.05' },
  { sku: 'T-18', sellPrice: '99.00', taxRate: '0.18' },
  { sku: 'T-MIX-A', sellPrice: '12.34', taxRate: '0.18' },
  { sku: 'T-MIX-B', sellPrice: '7.89', taxRate: '0.05' },
];

/**
 * Seeded `Inventory.onHand` per product. Sized far above any cart
 * the generators produce (1..5 lines × 1..5 quantity = 25 max
 * units per iteration × ~30 iterations = ~750 max burn) so the
 * out-of-stock branch never gates the property under test. Property
 * 3 (Phase 5, task 5.6) covers the underflow path explicitly.
 */
export const HIGH_ONHAND = 1_000_000;

// ---------------------------------------------------------------------------
// seedProductUniverse
// ---------------------------------------------------------------------------

/**
 * Seed an Admin actor + supplier + category + the five products
 * declared in `PRODUCT_SHAPES`, each backed by an `Inventory` row at
 * `HIGH_ONHAND`. Returns the ids the property test needs to drive
 * `finalizeSale` and assert against the persisted rows.
 *
 * Lifecycle: call once per test inside `beforeEach`, after
 * `createTempDb()` resolves. The fixture's dynamic re-import binds
 * every service module to the same per-test Prisma singleton, so
 * writes done here are visible to the SUT and vice versa.
 *
 * The Admin role is upserted by `prisma db seed` before the fixture
 * returns (see `temp-db.ts`), so `findUniqueOrThrow` is safe.
 */
export async function seedProductUniverse(fixture: TempDbFixture): Promise<SeedData> {
  const adminRole = await fixture.prisma.role.findUniqueOrThrow({
    where: { name: 'Admin' },
  });

  const actor = await fixture.prisma.user.create({
    data: {
      username: 'pbt-actor',
      // Hash placeholder — these tests never go through AuthService.
      passwordHash: 'pbt-not-a-real-hash',
      roleId: adminRole.id,
    },
  });

  const supplier = await fixture.prisma.supplier.create({
    data: { name: 'PBT Supplier' },
  });

  const category = await fixture.prisma.category.create({
    data: { name: 'PBT Category' },
  });

  const products: SeededProduct[] = [];
  for (const shape of PRODUCT_SHAPES) {
    const product = await fixture.prisma.product.create({
      data: {
        sku: shape.sku,
        name: `Product ${shape.sku}`,
        categoryId: category.id,
        // `buyPrice` does not matter for the POS properties; mirror
        // `sellPrice` so the row is self-consistent.
        buyPrice: shape.sellPrice,
        sellPrice: shape.sellPrice,
        taxRate: shape.taxRate,
      },
    });
    await fixture.prisma.inventory.create({
      data: { productId: product.id, onHand: HIGH_ONHAND },
    });
    products.push({
      id: product.id,
      sellPrice: shape.sellPrice,
      taxRate: shape.taxRate,
    });
  }

  return {
    actor: { id: actor.id },
    supplierId: supplier.id,
    products,
  };
}
