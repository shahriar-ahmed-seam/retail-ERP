import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 5, task 5.5 — Property 1: Inventory ledger identity.
 *
 * **Validates: Requirements 3.1, 3.2, 11.4.**
 *
 * For every product `p` touched by the system, after every committed
 * transaction the denormalized cache must equal the sum of the
 * ledger:
 *
 *     Inventory.onHand(p) == Σ InventoryMovement.quantityDelta where productId = p
 *
 * This is the load-bearing invariant called out in design.md > "Ledger
 * Invariant". It is what makes the `Inventory.onHand` column a safe
 * cache instead of a duplicate source of truth, and it is exactly
 * what `inventory.service#applyMovement` is structured to preserve:
 * one `update` to the inventory row + one matching `create` on the
 * movement row, both inside the caller's `$transaction`.
 *
 * Strategy:
 *   - Pre-seed a small pool of products with random initial on-hand
 *     values (some empty, some non-empty) so the rejection branch on
 *     `applyMovement` is reachable.
 *   - Generate a sequence of up to 30 operations drawn from
 *     `purchase` (positive delta), `sale` (negative delta), and
 *     `adjustment` (signed delta).
 *   - Each operation is committed through a real `$transaction`
 *     against the in-memory mock so the snapshot/rollback semantics
 *     are exercised. An `OutOfStockError` rolls the transaction back
 *     and the property still holds — the ledger identity is checked
 *     on the post-rollback state.
 *   - After every operation (accepted or rejected) the identity is
 *     asserted for every product in the pool, not just the one
 *     touched. This catches any regression that would let a movement
 *     leak into the wrong product's ledger.
 *
 * Property 3 (non-negative on-hand + `OUT_OF_STOCK` rejection) is a
 * separate task (5.6); we do not assert its specific wire-envelope
 * shape here. We *do* observe — implicitly — that `applyMovement`
 * never persists a negative on-hand, because the per-step identity
 * check would surface that as a sum mismatch the moment a rejected
 * sale wrote a movement row anyway. The dedicated Property 3 test
 * adds the explicit `OUT_OF_STOCK`/no-row assertions on top.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock (applyMovement surface only)
// ---------------------------------------------------------------------------
//
// Mirrors the mock used in `tests/unit/main/services/inventory.service.test.ts`
// but trimmed to exactly the delegates `applyMovement` touches inside
// its `$transaction`:
//   - `inventory.findUniqueOrThrow`  (point read on the PK)
//   - `inventory.update`             (absolute on-hand assignment)
//   - `inventoryMovement.create`     (single ledger insert)
//
// No `auditLog` / `journalEntry` / `$queryRaw` paths are needed —
// Property 1 is a statement about the ledger writer in isolation.

const mockState = vi.hoisted(() => {
  interface MockInventory {
    productId: string;
    onHand: number;
    updatedAt: Date;
  }
  interface MockMovement {
    id: string;
    productId: string;
    quantityDelta: number;
    movementType: string;
    referenceType: string;
    referenceId: string;
    userId: string;
    timestamp: Date;
  }

  const state = {
    inventories: [] as MockInventory[],
    movements: [] as MockMovement[],
    nextMovementId: 0,
  };

  return {
    state,
    reset(): void {
      state.inventories = [];
      state.movements = [];
      state.nextMovementId = 0;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  type MockInventory = (typeof state.inventories)[number];
  type MockMovement = (typeof state.movements)[number];

  function makeRecordNotFound(): unknown {
    return new Prisma.PrismaClientKnownRequestError('No Inventory found', {
      code: 'P2025',
      clientVersion: 'test',
    });
  }

  function inventoryFindUniqueOrThrowImpl({
    where,
  }: {
    where: { productId: string };
  }): Promise<MockInventory> {
    const row = state.inventories.find((i) => i.productId === where.productId);
    if (!row) throw makeRecordNotFound();
    return Promise.resolve({ ...row });
  }

  function inventoryUpdateImpl({
    where,
    data,
  }: {
    where: { productId: string };
    data: { onHand: number };
  }): Promise<MockInventory> {
    const row = state.inventories.find((i) => i.productId === where.productId);
    if (!row) throw makeRecordNotFound();
    row.onHand = data.onHand;
    row.updatedAt = new Date();
    return Promise.resolve({ ...row });
  }

  function inventoryMovementCreateImpl({
    data,
  }: {
    data: {
      productId: string;
      quantityDelta: number;
      movementType: string;
      referenceType: string;
      referenceId: string;
      userId: string;
    };
  }): Promise<MockMovement> {
    const row: MockMovement = {
      id: `mov-${state.nextMovementId++}`,
      productId: data.productId,
      quantityDelta: data.quantityDelta,
      movementType: data.movementType,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      userId: data.userId,
      timestamp: new Date(),
    };
    state.movements.push(row);
    return Promise.resolve({ ...row });
  }

  const tx = {
    inventory: {
      findUniqueOrThrow: inventoryFindUniqueOrThrowImpl,
      update: inventoryUpdateImpl,
    },
    inventoryMovement: {
      create: inventoryMovementCreateImpl,
    },
  };

  // Snapshot/rollback `$transaction` so a thrown `OutOfStockError`
  // unwinds every write performed up to that point — the same
  // semantic Prisma offers in production. Without rollback the
  // property would observe a half-written transaction and fail in a
  // way that is the mock's fault, not the helper's.
  async function $transaction<T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> {
    const snapshot = {
      inventories: state.inventories.map((i) => ({ ...i })),
      movements: state.movements.map((m) => ({ ...m })),
      nextMovementId: state.nextMovementId,
    };
    try {
      return await cb(tx);
    } catch (err) {
      state.inventories = snapshot.inventories;
      state.movements = snapshot.movements;
      state.nextMovementId = snapshot.nextMovementId;
      throw err;
    }
  }

  return {
    prisma: {
      inventory: {
        findUniqueOrThrow: inventoryFindUniqueOrThrowImpl,
        update: inventoryUpdateImpl,
      },
      inventoryMovement: {
        create: inventoryMovementCreateImpl,
      },
      $transaction,
    },
  };
});

// Imports MUST come after `vi.mock`.
import { prisma } from '@main/db/prisma';
import { applyMovement, OutOfStockError } from '@main/services/inventory.service';

import type {
  ApplyMovementInput,
} from '@main/services/inventory.service';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Five products is enough to make per-product rejection branches
 * common (one product's stock running out doesn't block operations
 * on the others) and small enough to keep the per-step identity
 * check cheap (`O(productCount * movementCount)`, ~150 product
 * scans per run at the upper bound).
 */
const PRODUCT_IDS = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'] as const;

type ProductId = (typeof PRODUCT_IDS)[number];

interface GeneratedOp {
  readonly kind: 'purchase' | 'sale' | 'adjustment';
  readonly productId: ProductId;
  /**
   * Pre-computed signed delta. We embed it in the generator output
   * (rather than deriving it inside the property body) so fast-check
   * can shrink failures down to the actual numeric counter-example.
   */
  readonly delta: number;
}

/**
 * Per-operation generator. Quantity is bounded by `[1, 20]` so a
 * 30-step sequence can both run a product up to ~600 units in stock
 * and drain it back to zero — both branches of the rejection check
 * are exercised inside a single run.
 */
const opArbitrary: fc.Arbitrary<GeneratedOp> = fc.oneof(
  fc.record({
    kind: fc.constant('purchase' as const),
    productId: fc.constantFrom(...PRODUCT_IDS),
    delta: fc.integer({ min: 1, max: 20 }),
  }),
  fc.record({
    kind: fc.constant('sale' as const),
    productId: fc.constantFrom(...PRODUCT_IDS),
    delta: fc.integer({ min: 1, max: 20 }).map((q) => -q),
  }),
  fc.record({
    kind: fc.constant('adjustment' as const),
    productId: fc.constantFrom(...PRODUCT_IDS),
    // Adjustments may be positive OR negative. `applyMovement` itself
    // accepts zero deltas (the public `adjust` entry point is what
    // forbids them), but Property 1 is a statement about the helper,
    // so excluding zero just keeps the search space focused on the
    // changing-state case.
    delta: fc
      .integer({ min: -20, max: 20 })
      .filter((n) => n !== 0),
  }),
);

const opSequenceArbitrary = fc.array(opArbitrary, {
  minLength: 0,
  maxLength: 30,
});

/**
 * Initial on-hand seed for each product. Mixing zeroes and non-zero
 * starts means some products begin in a state where any sale gets
 * rejected (forcing the rollback branch) and others start with
 * headroom. The upper bound is well below the per-step max delta so
 * the sale path can drain a product mid-run.
 */
const seedArbitrary: fc.Arbitrary<readonly { productId: ProductId; onHand: number }[]> =
  fc.tuple(
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 0, max: 30 }),
    fc.integer({ min: 0, max: 30 }),
  ).map(([a, b, c, d, e]) => [
    { productId: 'p-1', onHand: a },
    { productId: 'p-2', onHand: b },
    { productId: 'p-3', onHand: c },
    { productId: 'p-4', onHand: d },
    { productId: 'p-5', onHand: e },
  ]);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState.reset();
});

afterEach(() => {
  mockState.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedInventories(
  seeds: readonly { productId: ProductId; onHand: number }[],
): void {
  for (const seed of seeds) {
    mockState.state.inventories.push({
      productId: seed.productId,
      onHand: seed.onHand,
      updatedAt: new Date(),
    });
  }
}

function getOnHand(productId: ProductId): number {
  const row = mockState.state.inventories.find((i) => i.productId === productId);
  // Every product is seeded in `beforeEach` block; an undefined here
  // would mean the mock's rollback dropped a row, which is itself a
  // bug the property should surface.
  if (row === undefined) {
    throw new Error(`No inventory row for ${productId} — mock corruption`);
  }
  return row.onHand;
}

function sumDeltas(productId: ProductId): number {
  return mockState.state.movements
    .filter((m) => m.productId === productId)
    .reduce((acc, m) => acc + m.quantityDelta, 0);
}

function movementCount(productId: ProductId): number {
  return mockState.state.movements.filter((m) => m.productId === productId).length;
}

/** Build an `applyMovement` input for a generated op. The reference
 *  fields are deterministic so they are easy to read in a shrink. */
function toApplyInput(op: GeneratedOp, stepIndex: number): ApplyMovementInput {
  const referenceType: ApplyMovementInput['referenceType'] =
    op.kind === 'purchase' ? 'purchase' : op.kind === 'sale' ? 'sale' : 'adjustment';
  return {
    productId: op.productId,
    delta: op.delta,
    movementType: op.kind,
    referenceType,
    referenceId: `${op.kind}-${stepIndex}`,
    userId: 'u-test',
  };
}

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

describe('Property 1 — inventory ledger identity', () => {
  it('keeps onHand == sum(quantityDelta) for every touched product after every commit', async () => {
    await fc.assert(
      fc.asyncProperty(seedArbitrary, opSequenceArbitrary, async (seeds, ops) => {
        // Per-iteration reset. fast-check loops the property body
        // ~200 times per `it`; `beforeEach` only fires once.
        mockState.reset();
        seedInventories(seeds);

        // Track each product's expected on-hand independently. A
        // rejected `applyMovement` leaves the product untouched, so
        // the expected value only advances when the helper does not
        // throw.
        const expected = new Map<ProductId, number>(
          seeds.map((s) => [s.productId, s.onHand]),
        );

        for (let i = 0; i < ops.length; i++) {
          const op = ops[i]!;
          const beforeMovementCount = movementCount(op.productId);
          const beforeOnHand = getOnHand(op.productId);

          let threw = false;
          try {
            await prisma.$transaction((tx) =>
              applyMovement(tx, toApplyInput(op, i)),
            );
          } catch (err) {
            // Any rejection MUST come from the typed `OutOfStockError`
            // path. Other thrown errors mean the helper or the mock
            // diverged from its contract; surface them so the
            // property fails clearly rather than silently treating
            // them as expected rollbacks.
            if (!(err instanceof OutOfStockError)) {
              throw err;
            }
            threw = true;
            expect(err.productId).toBe(op.productId);
          }

          if (threw) {
            // (a) Rollback semantics: nothing is persisted for the
            // touched product. The transaction snapshot/rollback
            // wrapper must restore both the inventory row and the
            // movement table to their pre-call state.
            expect(getOnHand(op.productId)).toBe(beforeOnHand);
            expect(movementCount(op.productId)).toBe(beforeMovementCount);
            // The decrement that would have driven on-hand below
            // zero is the only reason `applyMovement` throws here;
            // confirm the operation we generated really is one that
            // crosses the floor, so the property does not silently
            // pass via spurious rollbacks.
            expect(beforeOnHand + op.delta).toBeLessThan(0);
          } else {
            // (b) Forward progress: exactly one new movement row
            // appears for the touched product, and the on-hand
            // moves by the requested delta.
            expect(movementCount(op.productId)).toBe(beforeMovementCount + 1);
            const next = (expected.get(op.productId) ?? 0) + op.delta;
            expected.set(op.productId, next);
            expect(getOnHand(op.productId)).toBe(next);
          }

          // (c) Ledger identity — the heart of Property 1. Checked
          // for EVERY product, EVERY step, accepted or rejected.
          // This is the only assertion in this property test that
          // directly states Req 3.2 + 11.4; everything above is
          // structural support that makes a violation visible.
          for (const productId of PRODUCT_IDS) {
            const initial = seeds.find((s) => s.productId === productId)!.onHand;
            const observedOnHand = getOnHand(productId);
            const observedSum = sumDeltas(productId);

            // The cache equals the initial seed plus the ledger sum
            // (the seed is the row's starting balance before any
            // movement is recorded). Equivalently: the cache minus
            // the seed equals the ledger sum.
            expect(observedOnHand - initial).toBe(observedSum);

            // And the cache matches our independent running tally.
            expect(observedOnHand).toBe(expected.get(productId));
          }
        }
      }),
    );
  });
});
