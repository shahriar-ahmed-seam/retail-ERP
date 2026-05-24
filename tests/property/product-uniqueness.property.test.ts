import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 4, task 4.5 — Property 7: Uniqueness of product identifiers.
 *
 * **Validates: Requirements 2.2, 2.3.**
 *
 * The system MUST reject any product insert whose `sku` reuses an
 * already-persisted `sku`, OR whose non-null `barcode` reuses an
 * already-persisted non-null `barcode`. Conversely, the persisted
 * product set MUST never contain two rows that share an `sku`, and
 * MUST never contain two rows that share a non-null `barcode`. This
 * property test runs `ProductService.upsert` against an in-memory
 * Prisma mock that simulates SQLite's unique-index enforcement; the
 * generator is intentionally biased toward collisions so the
 * rejection path is exercised on the majority of runs.
 *
 * The mock mirrors the one in
 * `tests/unit/main/services/product.service.test.ts` but is trimmed
 * to the exact surface the create path touches:
 *
 *   - `product.create`           (inside `$transaction`)
 *   - `inventory.create`         (inside `$transaction`)
 *   - `$transaction`             (snapshot/restore semantics)
 *
 * No `findMany` / `count` / `update` / `auditLog` paths are needed
 * here — Property 7 is a statement about inserts only, per the task
 * description.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock (insert-only surface)
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockProduct {
    id: string;
    sku: string;
    name: string;
    categoryId: string;
    barcode: string | null;
    buyPrice: string;
    sellPrice: string;
    taxRate: string;
    warrantyMonths: number;
    reorderLevel: number;
  }
  interface MockInventory {
    productId: string;
    onHand: number;
    updatedAt: Date;
  }
  interface MockCategory {
    id: string;
    name: string;
  }

  const state = {
    products: [] as MockProduct[],
    inventories: [] as MockInventory[],
    categories: [] as MockCategory[],
    nextProductId: 0,
  };

  return {
    state,
    reset(): void {
      state.products = [];
      state.inventories = [];
      state.categories = [];
      state.nextProductId = 0;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  type MockProduct = (typeof state.products)[number];
  type MockInventory = (typeof state.inventories)[number];

  function makeUniqueViolation(target: string[]): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      `Unique constraint failed on the fields: (\`${target.join(',')}\`)`,
      { code: 'P2002', clientVersion: 'test', meta: { target } },
    );
  }

  function makeFkViolation(field: string): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      `Foreign key constraint failed on the field: \`${field}\``,
      { code: 'P2003', clientVersion: 'test', meta: { field_name: field } },
    );
  }

  function attachJoins(row: MockProduct): unknown {
    const inv = state.inventories.find((i) => i.productId === row.id) ?? null;
    const cat = state.categories.find((c) => c.id === row.categoryId) ?? null;
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      categoryId: row.categoryId,
      barcode: row.barcode,
      buyPrice: new Prisma.Decimal(row.buyPrice),
      sellPrice: new Prisma.Decimal(row.sellPrice),
      taxRate: new Prisma.Decimal(row.taxRate),
      warrantyMonths: row.warrantyMonths,
      reorderLevel: row.reorderLevel,
      inventory: inv,
      category: cat ? { name: cat.name } : null,
    };
  }

  function createImpl({
    data,
  }: {
    data: {
      sku: string;
      name: string;
      categoryId: string;
      barcode?: string | null;
      buyPrice: { toString: () => string };
      sellPrice: { toString: () => string };
      taxRate: { toString: () => string };
      warrantyMonths: number;
      reorderLevel: number;
    };
  }): Promise<unknown> {
    if (!state.categories.some((c) => c.id === data.categoryId)) {
      throw makeFkViolation('Product_categoryId_fkey');
    }
    // SQLite's unique-index check fires before the row is committed.
    // The order matches the mock in the unit test: sku first, then
    // barcode. Either rejection surfaces as `UNIQUE_VIOLATION` once
    // mapped by the service.
    if (state.products.some((p) => p.sku === data.sku)) {
      throw makeUniqueViolation(['sku']);
    }
    if (
      data.barcode !== null &&
      data.barcode !== undefined &&
      state.products.some((p) => p.barcode === data.barcode)
    ) {
      throw makeUniqueViolation(['barcode']);
    }
    const row: MockProduct = {
      id: `prod-${state.nextProductId++}`,
      sku: data.sku,
      name: data.name,
      categoryId: data.categoryId,
      barcode: data.barcode ?? null,
      buyPrice: data.buyPrice.toString(),
      sellPrice: data.sellPrice.toString(),
      taxRate: data.taxRate.toString(),
      warrantyMonths: data.warrantyMonths,
      reorderLevel: data.reorderLevel,
    };
    state.products.push(row);
    return Promise.resolve(attachJoins(row));
  }

  function inventoryCreateImpl({
    data,
  }: {
    data: { productId: string; onHand: number };
  }): Promise<unknown> {
    const row: MockInventory = {
      productId: data.productId,
      onHand: data.onHand,
      updatedAt: new Date(),
    };
    state.inventories.push(row);
    return Promise.resolve({ ...row });
  }

  // Transaction handle exposed to `$transaction` callbacks. Mirrors
  // Prisma's contract: throws inside the callback roll back any
  // mutations applied through `tx`, so a unique-violation thrown
  // mid-transaction leaves both `products` and `inventories` empty
  // for that operation.
  const tx = {
    product: { create: createImpl },
    inventory: { create: inventoryCreateImpl },
  };

  async function $transaction<T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> {
    const snapshot = {
      products: state.products.map((p) => ({ ...p })),
      inventories: state.inventories.map((i) => ({ ...i })),
      nextProductId: state.nextProductId,
    };
    try {
      return await cb(tx);
    } catch (err) {
      state.products = snapshot.products;
      state.inventories = snapshot.inventories;
      state.nextProductId = snapshot.nextProductId;
      throw err;
    }
  }

  return {
    prisma: {
      product: { create: createImpl },
      inventory: { create: inventoryCreateImpl },
      $transaction,
    },
  };
});

// Imports MUST come after `vi.mock`.
import { ProductService } from '@main/services/product.service';

import type { ProductInput } from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * The pools are intentionally small so a sequence of 30 operations
 * has high probability of producing collisions on both `sku` and
 * `barcode`. This biases the generator toward exercising the
 * rejection path; with a uniform 64-char identifier space every
 * insert would succeed and the property would be vacuously true.
 *
 * Six skus + five barcodes against up to 30 operations means
 * collisions start appearing after ~6 inserts on average.
 */
const SKU_POOL = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const BARCODE_POOL = ['100', '200', '300', '400', '500'] as const;

interface GeneratedInsert {
  readonly sku: string;
  readonly barcode: string | null;
  readonly name: string;
}

/** A single product insert input drawn from the constrained pools. */
const insertArbitrary: fc.Arbitrary<GeneratedInsert> = fc.record({
  sku: fc.constantFrom(...SKU_POOL),
  // `fc.option` with `nil: null` produces `null` ~25% of the time so
  // the "barcode === null does not collide" branch is exercised.
  barcode: fc.option(fc.constantFrom(...BARCODE_POOL), { nil: null, freq: 4 }),
  // Names are arbitrary printable ASCII trimmed-non-empty strings.
  // The service trims whitespace and rejects empties, so we filter
  // the generator to inputs that pass validation regardless of the
  // identifier under test — this property is about uniqueness, not
  // string sanitization.
  name: fc
    .string({ minLength: 1, maxLength: 50, unit: 'grapheme-ascii' })
    .filter((s) => s.trim().length > 0),
});

/**
 * A sequence of 0..30 inserts. The empty case proves the property
 * holds vacuously on an untouched table; the upper bound keeps the
 * 200-run default tractable (≤ 6,000 service calls per property
 * run, all in-memory).
 */
const insertSequenceArbitrary = fc.array(insertArbitrary, {
  minLength: 0,
  maxLength: 30,
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState.reset();
  // Single category so every input passes the FK check; collisions
  // must surface via the unique indexes, not the FK.
  mockState.state.categories.push({ id: 'cat-1', name: 'Test Category' });
});

afterEach(() => {
  mockState.reset();
});

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

describe('Property 7 — uniqueness of product identifiers', () => {
  it('rejects every insert that reuses sku or non-null barcode and never persists collisions', async () => {
    await fc.assert(
      fc.asyncProperty(insertSequenceArbitrary, async (operations) => {
        // Reset between fast-check shrinking iterations. `beforeEach`
        // only runs once per `it`; fast-check loops the property body
        // ~200 times per iteration, so a per-property reset is required.
        mockState.reset();
        mockState.state.categories.push({ id: 'cat-1', name: 'Test Category' });

        for (const op of operations) {
          // Snapshot the pre-call state so we can verify rollback on
          // rejection and forward-progress on acceptance.
          const beforeSkus = new Set(mockState.state.products.map((p) => p.sku));
          const beforeBarcodes = new Set(
            mockState.state.products
              .filter((p): p is typeof p & { barcode: string } => p.barcode !== null)
              .map((p) => p.barcode),
          );
          const beforeProductCount = mockState.state.products.length;
          const beforeInventoryCount = mockState.state.inventories.length;

          const input: ProductInput = {
            sku: op.sku,
            name: op.name,
            categoryId: 'cat-1',
            barcode: op.barcode,
            buyPrice: '10',
            sellPrice: '15',
            taxRate: '0',
            warrantyMonths: 0,
            reorderLevel: 0,
          };

          const result = await ProductService.upsert(input, { userId: 'u-test' });

          // Determine whether this op should have been rejected by
          // the unique constraints. Note that `null` barcodes never
          // collide — multiple products without a barcode are allowed
          // (Req 2.3: "barcode is optional").
          const skuCollides = beforeSkus.has(op.sku);
          const barcodeCollides =
            op.barcode !== null && beforeBarcodes.has(op.barcode);
          const shouldReject = skuCollides || barcodeCollides;

          if (shouldReject) {
            // (a) The service MUST reject the insert with UNIQUE_VIOLATION.
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.error.code).toBe('UNIQUE_VIOLATION');
              // The reported field MUST be one of the two unique columns
              // and MUST identify a column that actually collides — the
              // service maps `P2002.meta.target` directly so an `sku`
              // collision can never surface as a `barcode` field error.
              const details = result.error.details as
                | { field?: 'sku' | 'barcode' }
                | undefined;
              expect(details?.field === 'sku' || details?.field === 'barcode').toBe(
                true,
              );
              if (details?.field === 'sku') {
                expect(skuCollides).toBe(true);
              } else if (details?.field === 'barcode') {
                expect(barcodeCollides).toBe(true);
              }
            }
            // (b) Database state MUST be unchanged: the rejection rolls
            // back the in-tx product insert AND the in-tx inventory
            // insert. This is the atomicity contract from Req 11.4
            // exercised through the uniqueness rejection path.
            expect(mockState.state.products).toHaveLength(beforeProductCount);
            expect(mockState.state.inventories).toHaveLength(beforeInventoryCount);
          } else {
            // (c) A non-colliding insert MUST be accepted.
            expect(result.ok).toBe(true);
            // (d) Both rows are persisted atomically (Req 3.2, 11.4).
            expect(mockState.state.products).toHaveLength(beforeProductCount + 1);
            expect(mockState.state.inventories).toHaveLength(beforeInventoryCount + 1);
          }

          // Global invariant — checked after EVERY operation, accepted
          // or rejected. This is the heart of Property 7:
          //   ∀ p1, p2 ∈ persisted, p1.id ≠ p2.id ⇒
          //       p1.sku ≠ p2.sku ∧
          //       (p1.barcode = null ∨ p2.barcode = null ∨ p1.barcode ≠ p2.barcode)
          const skus = mockState.state.products.map((p) => p.sku);
          expect(new Set(skus).size).toBe(skus.length);
          const nonNullBarcodes = mockState.state.products
            .filter((p): p is typeof p & { barcode: string } => p.barcode !== null)
            .map((p) => p.barcode);
          expect(new Set(nonNullBarcodes).size).toBe(nonNullBarcodes.length);
        }
      }),
    );
  });
});
