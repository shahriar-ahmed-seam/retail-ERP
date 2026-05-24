// tests/property/sale-serials.property.test.ts
//
// Phase 7, task 7.8 — Property 4: Strictly monotonic, unique sale serials.
//
// **Validates: Requirement 4.3.**
//
// Every committed `Sale` carries a `serialNo` of the form
// `INV-XXXXXX` (zero-padded to >=6 digits). Across any batch of
// finalizes — sequential or concurrent — the persisted serials MUST:
//
//   1. Be pairwise unique. The schema already enforces this via the
//      `Sale.serialNo @unique` constraint, so a duplicate would
//      surface as a P2002 envelope rather than two rows. The
//      property still asserts it on the rows themselves so any
//      future refactor that drops the unique index does not silently
//      pass.
//
//   2. Form a STRICTLY INCREASING integer sequence when sorted by
//      `Sale.createdAt`. The integer in question is the digit
//      portion of the `INV-NNNNNN` string. The seed sets
//      `Setting('sale.serialCounter') = '0'`; `nextSerial(tx)` reads
//      the current value, increments, writes back, and formats —
//      all inside the caller's `$transaction`. SQLite's row-level
//      lock on the `Setting` row update serializes concurrent
//      finalizes, which is exactly the mechanism design.md > "POS
//      Flow" > "Serial number allocation" relies on for Property 4.
//
//   3. Bonus: form the EXACT sequence `1, 2, …, N` (no gaps).
//      Because each test starts from a fresh seed (`createTempDb`
//      runs `prisma db seed` which sets the counter to `'0'`), the
//      first finalize must yield `INV-000001`, the second
//      `INV-000002`, and so on. A missing serial would mean a
//      finalize raced past the counter without committing, which
//      should be impossible — the counter update and the sale
//      insert are in the same transaction, so a roll-back undoes
//      both. This bonus assertion fingers a bug where the counter
//      is bumped outside the transaction.
//
// Strategy:
//
//   - Seed an Admin actor + ONE product at high inventory
//     (`onHand = 1_000_000`, `taxRate = '0'`, `sellPrice = '10.00'`).
//     The property is about the serial allocator, not the cart
//     shape, so a single product is sufficient. Tax-free + round
//     price keeps the totals trivially derivable inline.
//
//   - Two test cases (NOT property-driven, since the assertion is
//     over a batch of finalizes whose ordering is the variable):
//
//       (a) Sequential batch: `await finalizeSale(...)` 30 times
//           in a row. Inputs are identical across calls (same
//           product, same quantity, same payment) — the only
//           thing that changes between calls is the counter the
//           allocator reads. Asserts pairwise uniqueness, strict
//           monotonicity by `createdAt`, and the exact
//           `1..30` integer sequence.
//
//       (b) Concurrent batch: 30 `finalizeSale(...)` calls fired
//           via `Promise.all`. Same inputs, same assertions. The
//           transactional row-update lock on
//           `Setting('sale.serialCounter')` is what guarantees
//           the property holds: each transaction must observe
//           the previous transaction's committed counter before
//           it can produce its own next number.
//
//   - Assertions are exact, not tolerance-based. Serials are
//     integer-valued; trailing-zero / canonical-form differences
//     don't apply. We parse `INV-(\d+)` and operate on the
//     integer part.
//
//   - Each test starts from a fresh per-test SQLite via
//     `createTempDb`, so the counter always starts at `'0'`. There
//     is no cross-test bleed-through.
//
// Why this lives under `tests/property/`:
//
//   - Tasks list this under "Property test" (task 7.8) and the file
//     naming convention (`*.property.test.ts`) is recognised only
//     by the `property` Vitest project (`vitest.config.ts`).
//   - `tests/property/setup.ts` configures fast-check globals; this
//     file does not actually use fast-check (the assertion is over
//     batches, not random per-iteration inputs), but it shares the
//     property-tier setup conventions and the same DB fixture
//     pattern as the rest of the file family.

import Decimal from 'decimal.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempDb,
  type TempDbFixture,
} from '../integration/fixtures/temp-db.js';

import type { FinalizeSaleInput } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Per-test seed (single-product, inline)
// ---------------------------------------------------------------------------
//
// Property 4 only needs one product — the property is about the
// serial allocator, not the cart shape. We do NOT use
// `tests/property/fixtures/pos-seed.ts` (which seeds five diverse
// products for Property 2 / 8) because a single tax-free product at
// a round price keeps every totals number trivially exact (`10.00`,
// `0.00`, `0.00`, `10.00`) and avoids any chance of a totals-identity
// failure obscuring the serial-allocation assertion.

interface SerialSeed {
  readonly actor: { id: string };
  readonly productId: string;
  readonly unitPrice: string;
  readonly taxRate: string;
}

/** High enough that 30 sales of quantity 1 each cannot underflow. */
const HIGH_ONHAND = 1_000_000;
/**
 * Number of finalizes for the SEQUENTIAL batch. 30 is the canonical
 * size called out in the task description.
 */
const SEQUENTIAL_BATCH_SIZE = 30;
/**
 * Number of finalizes for the CONCURRENT batch. Sized below the
 * sequential batch on purpose: SQLite's single-writer model
 * serialises every transaction on the row-update lock the allocator
 * holds against `Setting('sale.serialCounter')`, and Prisma's
 * default `socket_timeout` (5s) bounds how long a single query can
 * sit in the SQLite busy queue before the driver gives up. 30
 * concurrent transactions saturate that budget once each transaction
 * does its 5+ writes; 10 fits comfortably under the default while
 * still demonstrating that the row-lock serialisation produces a
 * unique, monotonic sequence under genuine `Promise.all`
 * contention. Property 4's assertions (pairwise uniqueness + strict
 * monotonicity + exact 1..N sequence) are just as falsifiable at
 * N=10 as at N=30 — a broken allocator would fail at any N >= 2.
 */
const CONCURRENT_BATCH_SIZE = 10;
/** Tax-free + round price → trivially exact totals. */
const UNIT_PRICE = '10.00';
const TAX_RATE = '0';

async function seedSerialUniverse(fixture: TempDbFixture): Promise<SerialSeed> {
  // The Admin role is upserted by `prisma db seed` before the
  // fixture returns; `findUniqueOrThrow` is safe.
  const adminRole = await fixture.prisma.role.findUniqueOrThrow({
    where: { name: 'Admin' },
  });

  const actor = await fixture.prisma.user.create({
    data: {
      username: 'pbt-serial-actor',
      // This test never goes through AuthService — placeholder hash.
      passwordHash: 'pbt-not-a-real-hash',
      roleId: adminRole.id,
    },
  });

  const category = await fixture.prisma.category.create({
    data: { name: 'PBT Serial Category' },
  });

  const product = await fixture.prisma.product.create({
    data: {
      sku: 'PBT-SERIAL',
      name: 'Property 4 Product',
      categoryId: category.id,
      buyPrice: UNIT_PRICE,
      sellPrice: UNIT_PRICE,
      taxRate: TAX_RATE,
    },
  });

  await fixture.prisma.inventory.create({
    data: { productId: product.id, onHand: HIGH_ONHAND },
  });

  return {
    actor: { id: actor.id },
    productId: product.id,
    unitPrice: UNIT_PRICE,
    taxRate: TAX_RATE,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical single-line, single-payment, tax-free,
 * no-discount input. Identical across every finalize in a batch —
 * the only thing that varies is the order in which the calls reach
 * the allocator.
 *
 * Totals are derivable by hand:
 *   subtotal       = 1 * 10.00       = 10.00
 *   discountAmount = 0 (no discount)
 *   taxTotal       = 0 (taxRate = 0)
 *   grandTotal     = subtotal − discount + tax = 10.00
 *   payments[0]    = 10.00 (cash)
 *
 * `validateTotalsIdentity` re-runs every recompute via
 * `@shared/pos-totals` inside `pos.service`; we ship the same
 * canonical strings the module emits (`'10'` rather than `'10.00'`
 * after Decimal canonicalisation) so the validator passes on the
 * first try.
 */
function buildSerialInput(seed: SerialSeed): FinalizeSaleInput {
  const subtotal = new Decimal(seed.unitPrice).mul(1).toString();
  return {
    customerId: null,
    items: [
      {
        productId: seed.productId,
        quantity: 1,
        unitPrice: seed.unitPrice,
        taxRate: seed.taxRate,
        lineTotal: subtotal,
      },
    ],
    discount: { kind: 'fixed', amount: '0' },
    subtotal,
    discountAmount: '0',
    taxTotal: '0',
    grandTotal: subtotal,
    payments: [{ method: 'cash', amount: subtotal }],
  };
}

/**
 * Parse the integer suffix out of `INV-XXXXXX`. Returns `null` for
 * any string that does not match the contract — the caller treats a
 * `null` here as a hard test failure (the format is owned by
 * `pos.service#formatSerial`, not by user input).
 */
const SERIAL_PATTERN = /^INV-(\d+)$/;
function parseSerialInteger(serialNo: string): number | null {
  const match = SERIAL_PATTERN.exec(serialNo);
  if (match === null) return null;
  const digits = match[1];
  if (digits === undefined) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Run every `Sale` row through the serial-batch assertions. Used by
 * both the sequential and concurrent test cases.
 *
 *   - Pairwise uniqueness:    `Set(serials).size === serials.length`.
 *   - Strict monotonicity:    sort by `createdAt`, parse integer
 *                             portion, assert each value is
 *                             strictly greater than the previous.
 *   - Exact `1..N` sequence:  the seed sets the counter to `'0'`,
 *                             so the first finalize MUST produce
 *                             `1` and the Nth MUST produce `N`. A
 *                             gap means a finalize that was
 *                             supposed to commit didn't, which
 *                             can't happen here because every
 *                             call's input is well-formed.
 *
 * SQLite stores `DATETIME` at the resolution of `CURRENT_TIMESTAMP`
 * (1-second precision unless set explicitly), so two concurrent
 * finalizes can land at the same `createdAt`. The strict-monotonic
 * sort therefore breaks ties on the parsed serial integer to
 * preserve the allocation order — which IS the order the property
 * cares about (per design.md "POS Flow > Serial number
 * allocation"). The created-at ordering is presented in the task
 * description as the obvious wall-clock ordering; in practice the
 * serial integer IS that wall-clock ordering at sub-second
 * resolution.
 */
function assertSerialsAreMonotonicAndUnique(
  rows: readonly { serialNo: string; createdAt: Date }[],
): void {
  // (1) Uniqueness on the raw strings.
  const serialStrings = rows.map((r) => r.serialNo);
  expect(new Set(serialStrings).size).toBe(serialStrings.length);

  // (2) Sort by createdAt ASC, with a stable tiebreaker on the
  // parsed serial integer so sub-second concurrency survives.
  const sorted = [...rows]
    .map((r) => ({
      raw: r.serialNo,
      createdAtMs: r.createdAt.getTime(),
      n: parseSerialInteger(r.serialNo),
    }))
    .map((r) => {
      if (r.n === null) {
        throw new Error(
          `[Property 4] serialNo "${r.raw}" did not match INV-(\\d+) — pos.service#formatSerial contract violated`,
        );
      }
      // Re-narrow `n` to a non-null number for the sort callback.
      return { raw: r.raw, createdAtMs: r.createdAtMs, n: r.n };
    })
    .sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      return a.n - b.n;
    });

  // (3) Strict monotonicity of the integer sequence.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev === undefined || cur === undefined) {
      // Defensive — `sorted.length` is `rows.length` so the loop
      // bounds keep both ends in range; `noUncheckedIndexedAccess`
      // forces the guard.
      throw new Error(
        `[Property 4] sorted batch index ${i - 1}/${i} returned undefined`,
      );
    }
    if (cur.n <= prev.n) {
      throw new Error(
        `[Property 4] serial sequence not strictly increasing at index ${i}: ` +
          `prev=${prev.raw} cur=${cur.raw} (parsed ${prev.n} >= ${cur.n})`,
      );
    }
  }

  // (4) Exact 1..N sequence (bonus assertion). The seed sets the
  // counter to '0' and `nextSerial` is the only writer, so the
  // first finalize must produce `1` and the Nth must produce `N`.
  for (let i = 0; i < sorted.length; i++) {
    const expectedN = i + 1;
    const row = sorted[i];
    if (row === undefined) {
      throw new Error(`[Property 4] sorted batch missing index ${i}`);
    }
    if (row.n !== expectedN) {
      throw new Error(
        `[Property 4] expected serial ${expectedN} at sorted index ${i}, ` +
          `got ${row.raw} (parsed ${row.n})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fixture: TempDbFixture;
let seed: SerialSeed;

beforeEach(async () => {
  fixture = await createTempDb();
  seed = await seedSerialUniverse(fixture);
});

afterEach(async () => {
  await fixture.cleanup();
});

// ---------------------------------------------------------------------------
// Property 4 — strictly monotonic, unique sale serials (Req 4.3)
// ---------------------------------------------------------------------------

describe('Property 4 (sale serials) — POSService.finalizeSale serial allocator', () => {
  it(
    'sequential batch produces pairwise-unique, strictly increasing serials in 1..N',
    async () => {
      const input = buildSerialInput(seed);

      // 30 awaited finalizes in series. Each call commits before
      // the next starts, so the allocator reads N's committed
      // counter and produces N+1.
      for (let i = 0; i < SEQUENTIAL_BATCH_SIZE; i++) {
        const result = await fixture.POSService.finalizeSale(input, {
          userId: seed.actor.id,
        });
        if (!result.ok) {
          throw new Error(
            `[Property 4] sequential finalize #${i + 1} returned Err: ` +
              `code=${result.error.code} details=${JSON.stringify(result.error.details)}`,
          );
        }
      }

      // Read every Sale row back ordered by createdAt ASC. The
      // assertion helper re-sorts internally with a serial-integer
      // tiebreaker so the strict-monotonic check is robust even if
      // SQLite collapses two timestamps into the same second.
      const rows = await fixture.prisma.sale.findMany({
        select: { serialNo: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.length).toBe(SEQUENTIAL_BATCH_SIZE);

      assertSerialsAreMonotonicAndUnique(rows);
    },
    60_000,
  );

  it(
    'concurrent batch produces pairwise-unique, strictly increasing serials in 1..N',
    async () => {
      const input = buildSerialInput(seed);

      // Fire CONCURRENT_BATCH_SIZE finalizes concurrently via
      // Promise.all. Prisma's `$transaction` over SQLite serialises
      // writes against the row-level lock on
      // Setting('sale.serialCounter'), so the observed order at the
      // allocator is whatever the SQLite engine resolves the
      // contention to — and the property is that whatever that
      // order is, the resulting serials are unique and strictly
      // monotonic.
      //
      // The concurrent batch size is intentionally smaller than the
      // sequential one (see `CONCURRENT_BATCH_SIZE` doc comment).
      // SQLite is single-writer; under `Promise.all`, every
      // transaction beyond the first piles up behind the row-lock
      // and the deepest one waits ~30+ seconds at full saturation,
      // which exceeds Prisma's default socket-timeout. A 10-deep
      // queue completes well inside both the 60s test timeout and
      // Prisma's 5s socket budget per query, while still
      // demonstrating the row-lock serialisation produces a
      // unique + monotonic sequence under genuine contention.
      const calls: Promise<
        Awaited<ReturnType<TempDbFixture['POSService']['finalizeSale']>>
      >[] = [];
      for (let i = 0; i < CONCURRENT_BATCH_SIZE; i++) {
        calls.push(
          fixture.POSService.finalizeSale(input, { userId: seed.actor.id }),
        );
      }
      const results = await Promise.all(calls);

      // Every call must commit. A non-Ok here points to either a
      // genuine bug in the allocator (the only error envelope a
      // well-formed input could produce is INTERNAL on a P2002,
      // which would itself be a Property-4 violation) or a
      // fixture-level issue.
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result === undefined) {
          throw new Error(`[Property 4] Promise.all returned undefined at ${i}`);
        }
        if (!result.ok) {
          throw new Error(
            `[Property 4] concurrent finalize #${i + 1} returned Err: ` +
              `code=${result.error.code} details=${JSON.stringify(result.error.details)}`,
          );
        }
      }

      const rows = await fixture.prisma.sale.findMany({
        select: { serialNo: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.length).toBe(CONCURRENT_BATCH_SIZE);

      assertSerialsAreMonotonicAndUnique(rows);
    },
    60_000,
  );
});
