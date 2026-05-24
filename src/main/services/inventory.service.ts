// src/main/services/inventory.service.ts
//
// Inventory ledger writer (Phase 5, tasks 5.1 + 5.2).
//
// This module is the heart of the system per design.md > "Inventory
// Ledger Invariant". It exposes a single internal helper —
// `applyMovement` — that every business transaction (sale, purchase,
// manual adjustment, return) calls inside its own `$transaction` to
// produce exactly one paired write:
//
//   1. UPDATE Inventory.onHand for the target product.
//   2. INSERT InventoryMovement carrying the same `quantityDelta`.
//
// Both writes happen inside the caller's `tx` handle so the ledger
// invariant
//
//   onHand(p) == sum(InventoryMovement.quantityDelta where productId = p)
//
// holds at every commit boundary (Property 1 in design.md, Req 3.2 +
// 11.4). No other code path in the codebase MAY write to `Inventory.onHand`
// without writing the matching movement row, and vice versa — that is
// what makes the denormalized cache safe.
//
// On the decrement path (sales, negative adjustments) the helper rejects
// the write if it would drive `onHand` below zero (Req 3.7). The
// pre-check is done inside the transaction body using
// `findUniqueOrThrow` against the row's primary key, which under SQLite
// + WAL serializes against the subsequent `update` so two concurrent
// writers cannot both pass the check on the last unit of stock — one
// will see the decremented value and reject. The matching test for that
// behaviour lives in the property suite (Property 3, task 5.6).
//
// `applyMovement` deliberately uses a plain `update({ onHand: newOnHand })`
// rather than Prisma's `{ decrement }` / `{ increment }` operators. The
// operators would re-read and re-modify atomically at SQL level, but
// they bypass the application's pre-check — and we need the pre-check
// to surface the typed `OutOfStockError` envelope (mapped to
// `Err('OUT_OF_STOCK')` by the IPC router middleware) instead of
// letting SQLite roll back with an opaque check-constraint violation.
//
// `OutOfStockError` is exported as a named class so the IPC router and
// the property tests can pattern-match on it. It extends `Error` and
// carries the offending `productId` so the renderer can mark the
// specific cart line that caused the rejection (POS UI, task 7.6).
//
// The `InventoryService` literal exposes ONLY `applyMovement` for now.
// Phase 5 task 5.2 adds the public `adjust(...)` entry point (manual
// stock adjustment from the UI), and task 5.3 adds the low-stock
// queries. Both will be appended to this same literal so callers
// import a single named symbol.
//
// Validates: Requirements 3.1, 3.2, 3.7, 11.4.

import {
  Prisma,
  type Inventory,
  type InventoryMovement,
} from '@prisma/client';

import { paginateCursor, type PaginateModel, type PaginateWhere } from '@main/db/paginate.js';
import { prisma } from '@main/db/prisma.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type {
  AdjustmentInput,
  InventoryMovementDTO,
  MovementFilter,
  MovementSortKey,
  MovementType,
  ReferenceType,
} from '@shared/dto/index.js';
import type {
  ListRequest,
  ListResponse,
  LowStockRow,
} from '@shared/ipc-contract.js';

// Re-export the movement-type discriminators so callers (pos.service,
// purchase.service, the upcoming adjust path) can import a single
// named symbol from `@main/services` without reaching into
// `@shared/dto` directly. Keeps the service's public surface
// self-contained.
export type { MovementType, ReferenceType } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `applyMovement` when the requested `delta` would make the
 * product's `onHand` go negative (Req 3.7). The IPC router maps this
 * to `Err('OUT_OF_STOCK', { productId })` at the wire boundary.
 *
 * Extends `Error` so it propagates through `prisma.$transaction` like
 * any other thrown exception — the transaction body unwinds and
 * Prisma rolls back every write performed up to that point. The
 * inventory update and the movement insert never reach the database.
 *
 * The class is exported (named, not anonymous) so callers and tests
 * can `instanceof`-check it. `productId` is retained on the instance
 * so the renderer can mark the offending cart line without parsing
 * the message string.
 */
export class OutOfStockError extends Error {
  public readonly productId: string;

  public constructor(productId: string) {
    super(`Out of stock for product ${productId}`);
    this.name = 'OutOfStockError';
    this.productId = productId;
    // Restore the prototype chain — required when extending built-ins
    // under the `target: ES5` lib that older Electron toolchains use.
    // No-op under the modern ES2022 target this project uses, but
    // cheap insurance.
    Object.setPrototypeOf(this, OutOfStockError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Helper input shape
// ---------------------------------------------------------------------------

/**
 * Input shape for `applyMovement`. All fields are required — a missing
 * `userId` or `referenceId` would leave the movement row with no
 * actor / parent attribution, which the audit invariants in design.md
 * forbid. The caller (pos / purchase / adjust services) is responsible
 * for filling them in from the active session and the parent
 * business-event row created earlier in the same transaction.
 */
export interface ApplyMovementInput {
  /** Product whose `Inventory.onHand` is being moved. */
  readonly productId: string;
  /**
   * Signed integer change. Positive for receipts and returns,
   * negative for sales, signed (in either direction) for manual
   * adjustments. Must be a non-zero integer; the helper does not
   * itself enforce non-zero because the DTO contract — and the
   * services that build this shape — already do, and zero-delta
   * movements are sometimes useful as audit-only markers for
   * future ops (e.g. "stock count confirmed; no change").
   */
  readonly delta: number;
  /** Movement-type discriminator persisted to the ledger row. */
  readonly movementType: MovementType;
  /** Reference-type discriminator (parent business-event kind). */
  readonly referenceType: ReferenceType;
  /** Foreign key into the parent business-event row. */
  readonly referenceId: string;
  /** Acting user id; persisted on the movement row for audit. */
  readonly userId: string;
}

/** Return shape of `applyMovement`. */
export interface ApplyMovementResult {
  readonly inventory: Inventory;
  readonly movement: InventoryMovement;
}

// ---------------------------------------------------------------------------
// applyMovement
// ---------------------------------------------------------------------------

/**
 * Apply one ledger-of-record stock change inside the caller's
 * `$transaction`.
 *
 * Order of operations (matters):
 *
 *   1. `findUniqueOrThrow` on `Inventory(productId)` to read the
 *      committed-or-tx-pending `onHand` value. The row is the
 *      primary key target so the lookup is an indexed point read.
 *      Throws (and rolls the transaction back) if the inventory row
 *      is missing — every product has a matching inventory row by
 *      construction (`product.service.ts#upsert` creates them in
 *      lock-step), so a missing row is a data-integrity bug, not a
 *      validation error.
 *   2. Compute `newOnHand = current + delta`. Reject with
 *      `OutOfStockError(productId)` if it would go negative
 *      (Req 3.7). The error propagates out of the transaction body
 *      and Prisma rolls back; no inventory update, no movement row,
 *      no parent business-event row.
 *   3. `update` the inventory row to the absolute `newOnHand` value
 *      rather than using `{ decrement }` / `{ increment }`. This
 *      keeps the cached `onHand` in lock-step with the helper's
 *      pre-check semantics — a future caller staring at the
 *      committed row sees exactly the value the pre-check
 *      validated.
 *   4. `create` exactly one `InventoryMovement` row carrying the
 *      same `delta`, the discriminators, and the parent reference.
 *      The single `create` call (per `applyMovement` invocation) is
 *      what makes the ledger invariant tractable — every caller
 *      writes exactly one movement per stock change.
 *
 * Returns the freshly-updated inventory row and the freshly-inserted
 * movement row so the caller can include them in the parent
 * transaction's response payload (e.g. for the adjustment IPC reply
 * which echoes the new `movementId`).
 *
 * The helper is intentionally NOT exported on the `InventoryService`
 * literal: it is module-private to this file and the services that
 * import it directly (`pos.service`, `purchase.service`, and the
 * upcoming public `adjust` entry point in task 5.2). Renderer code
 * never sees it; it crosses the IPC boundary only via its callers'
 * higher-level transactions.
 *
 * @throws OutOfStockError if `delta` would make `onHand` negative.
 * @throws Prisma errors propagate (record not found, FK violations,
 *         etc.) and the caller's transaction handles them.
 */
export async function applyMovement(
  tx: Prisma.TransactionClient,
  input: ApplyMovementInput,
): Promise<ApplyMovementResult> {
  const { productId, delta, movementType, referenceType, referenceId, userId } = input;

  // Step 1 — read the committed/tx-pending on-hand for this product.
  // `findUniqueOrThrow` against the primary key throws
  // `PrismaClientKnownRequestError(P2025)` if the row is missing,
  // which is a data-integrity bug (every product is created with its
  // inventory row in `product.service.ts#upsert`); we let it
  // propagate so the caller's transaction rolls back.
  const current = await tx.inventory.findUniqueOrThrow({
    where: { productId },
  });

  // Step 2 — compute and validate the post-write on-hand. Reject
  // negative outcomes with the typed error so the IPC router can map
  // it to `Err('OUT_OF_STOCK', { productId })`.
  const newOnHand = current.onHand + delta;
  if (newOnHand < 0) {
    throw new OutOfStockError(productId);
  }

  // Step 3 — write the absolute on-hand value. Using an absolute
  // assignment (rather than `{ decrement }` / `{ increment }`) keeps
  // the cache in lock-step with the helper's pre-check.
  const inventory = await tx.inventory.update({
    where: { productId },
    data: { onHand: newOnHand },
  });

  // Step 4 — append exactly one ledger row. The discriminators come
  // straight from the input; the timestamp defaults via the schema.
  const movement = await tx.inventoryMovement.create({
    data: {
      productId,
      quantityDelta: delta,
      movementType,
      referenceType,
      referenceId,
      userId,
    },
  });

  return { inventory, movement };
}

// ---------------------------------------------------------------------------
// adjust — public manual-adjustment entry point (Phase 5, task 5.2)
// ---------------------------------------------------------------------------

/** Application-level bound on the `reason` text persisted to the audit log. */
const REASON_MIN = 1;
const REASON_MAX = 200;

/** Validate the public `adjust` input shape. Returns a normalized payload
 *  or the offending field name as the failing-side string. */
function validateAdjustInput(
  input: AdjustmentInput,
):
  | { ok: true; productId: string; quantityDelta: number; reason: string }
  | { ok: false; field: 'productId' | 'quantityDelta' | 'reason' } {
  // productId: non-empty string. The FK_VIOLATION on a missing product
  // surfaces from the inventory pre-check inside `applyMovement` (it
  // throws P2025), so this check is a fast-fail for client-side typos.
  if (typeof input.productId !== 'string' || input.productId.length === 0) {
    return { ok: false, field: 'productId' };
  }
  const productId = input.productId;

  // quantityDelta: non-zero integer. Zero deltas are rejected because
  // the public surface is "manual adjustment" — a zero adjustment has
  // no business semantics and would only pollute the audit log.
  if (typeof input.quantityDelta !== 'number') {
    return { ok: false, field: 'quantityDelta' };
  }
  if (!Number.isFinite(input.quantityDelta) || !Number.isInteger(input.quantityDelta)) {
    return { ok: false, field: 'quantityDelta' };
  }
  if (input.quantityDelta === 0) {
    return { ok: false, field: 'quantityDelta' };
  }
  const quantityDelta = input.quantityDelta;

  // reason: non-empty trimmed string with bounded length. The bound
  // protects the audit-log row from unbounded JSON growth; it is
  // generous enough that any human-typed reason passes.
  if (typeof input.reason !== 'string') {
    return { ok: false, field: 'reason' };
  }
  const trimmedReason = input.reason.trim();
  if (trimmedReason.length < REASON_MIN || trimmedReason.length > REASON_MAX) {
    return { ok: false, field: 'reason' };
  }

  return { ok: true, productId, quantityDelta, reason: trimmedReason };
}

/**
 * Generate a fresh "adjustment id" used as the parent reference for
 * the trio of rows written by `adjust`:
 *
 *   - `InventoryMovement.referenceId`
 *   - `AuditLog.entityId` (and embedded in `next.adjustmentId`)
 *   - `JournalEntry.payload.adjustmentId`
 *
 * No `Adjustment` table exists in the schema (manual adjustments do
 * not have a parent business-event row by design — see design.md >
 * "Project Structure"). Using a single id across all three writes
 * lets recovery and auditing correlate the rows without joining on
 * timestamps.
 *
 * `crypto.randomUUID()` is used rather than a third-party `cuid`
 * library because no such package is installed; UUID v4 has the same
 * uniqueness guarantees and is suitable for an opaque correlation
 * token.
 */
function generateAdjustmentId(): string {
  return `adj_${crypto.randomUUID()}`;
}

/**
 * Public manual stock adjustment entry point (Req 3.5, 13.3).
 *
 * Opens one `$transaction` and performs three writes inside it:
 *
 *   1. `applyMovement` — updates `Inventory.onHand` AND inserts one
 *      `InventoryMovement` row (`movementType: 'adjustment'`,
 *      `referenceType: 'adjustment'`, `referenceId: adjustmentId`).
 *   2. Inserts an `AuditLog` row of type `stock.adjust` carrying the
 *      product id, the `previous` on-hand snapshot, and a `next`
 *      payload with the delta + reason + adjustmentId so an Admin
 *      browsing the audit log can see exactly what changed (Req 13.3).
 *   3. Inserts a `JournalEntry` row of `opType: 'adjustment'` whose
 *      payload is the JSON snapshot needed to replay the adjustment
 *      after a snapshot restore (Req 10.4).
 *
 * Atomicity (Req 11.x): all three writes share one `$transaction` so a
 * failure on any single row rolls every preceding write back. The
 * inventory cache + ledger row + audit row + journal row either all
 * commit together or none of them do.
 *
 * Errors:
 *
 *   - `Err('VALIDATION', { field })` for bad inputs (productId empty,
 *     non-integer or zero delta, reason out of bounds).
 *   - `Err('OUT_OF_STOCK', { productId })` when a negative adjustment
 *     would drive `onHand` below zero. The transaction body throws
 *     `OutOfStockError` from inside `applyMovement`; this method
 *     catches it outside the `$transaction` and maps to the wire
 *     envelope. Prisma rolls back; nothing is persisted.
 *   - `Err('FK_VIOLATION', { reason: 'not_found' })` when the product
 *     is unknown — `applyMovement` throws Prisma's P2025 because the
 *     `Inventory(productId)` row is missing. Mapped here so the
 *     renderer can surface "product not found" instead of "internal
 *     error".
 *   - Any other error propagates and the IPC router maps it to
 *     `Err('INTERNAL', { errorId })`.
 *
 * Returns `{ movementId }` matching the `inventory:adjust` IPC
 * contract — the rest of the row data is observable through the
 * `inventory_movements:list` channel.
 *
 * Validates: Requirements 3.5, 13.3, 11.1.
 */
async function adjust(
  input: AdjustmentInput,
  ctx: { userId: string },
): Promise<Result<{ movementId: string }>> {
  const validated = validateAdjustInput(input);
  if (!validated.ok) {
    return Err('VALIDATION', { field: validated.field });
  }
  const { productId, quantityDelta, reason } = validated;

  const adjustmentId = generateAdjustmentId();

  try {
    const movementId = await prisma.$transaction(async (tx) => {
      // Capture the on-hand value before the movement so the audit row
      // carries an honest "previous" snapshot. `applyMovement` itself
      // also reads the inventory row, but it does not return the
      // pre-write value — the duplicate read here is cheap (point
      // read on the PK) and keeps the audit semantics tight.
      const prior = await tx.inventory.findUniqueOrThrow({
        where: { productId },
      });

      const result = await applyMovement(tx, {
        productId,
        delta: quantityDelta,
        movementType: 'adjustment',
        referenceType: 'adjustment',
        referenceId: adjustmentId,
        userId: ctx.userId,
      });

      // Audit row (Req 13.3). The `entityType: 'product'` keeps it
      // groupable with price-change rows on a single product detail
      // view; `entityId` is the productId so admins can pivot the
      // audit log on a single product.
      await tx.auditLog.create({
        data: {
          actionType: 'stock.adjust',
          entityType: 'product',
          entityId: productId,
          previous: JSON.stringify({ onHand: prior.onHand }),
          next: JSON.stringify({
            adjustmentId,
            quantityDelta,
            reason,
            onHand: result.inventory.onHand,
          }),
          userId: ctx.userId,
        },
      });

      // Journal row (Req 10.4). The payload contains everything a
      // replay needs to reapply the adjustment if a snapshot restore
      // happens later — productId, signed delta, the actor, the
      // adjustmentId for correlation, and an ISO timestamp captured
      // at write time (the row's own `timestamp` column also
      // defaults to `now()`, but embedding it in the payload
      // preserves it across schema migrations).
      await tx.journalEntry.create({
        data: {
          opType: 'adjustment',
          payload: JSON.stringify({
            adjustmentId,
            productId,
            quantityDelta,
            reason,
            userId: ctx.userId,
            timestamp: new Date().toISOString(),
          }),
        },
      });

      return result.movement.id;
    });

    return Ok({ movementId });
  } catch (err) {
    if (err instanceof OutOfStockError) {
      return Err('OUT_OF_STOCK', { productId });
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2025'
    ) {
      // `applyMovement` calls `findUniqueOrThrow` against
      // `Inventory(productId)` which throws P2025 when the product
      // (and therefore its inventory row) is unknown. Map to a wire
      // envelope so the renderer can render "product not found"
      // instead of an INTERNAL toast.
      return Err('FK_VIOLATION', { reason: 'not_found' });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Low-stock queries (Phase 5, task 5.3) — Req 3.6, 9.3
// ---------------------------------------------------------------------------
//
// Both queries pivot on the cross-column predicate
// `Inventory.onHand <= Product.reorderLevel`. SQLite/Prisma cannot
// express a "compare a column on one table to a column on a related
// table" filter through the relation API (no `lte: { _ref: 'p.reorderLevel' }`),
// so the queries are issued as `$queryRaw` against the joined tables.
// `Prisma.sql` builds a parameterized prepared statement; both queries
// have no user-supplied values and are pure column projections.
//
// `ProductService` (Phase 4) carries a private `fetchLowStockProductIds`
// helper that runs the same join to drive the `lowStockOnly: true`
// filter on `products:list`. We do not yet share a single helper —
// consolidating that path with these public methods is a future
// cleanup; keeping the duplication here keeps task 5.3 focused on
// exposing the public surface without rewiring task 4.2.

/**
 * Public count of products at or below their reorder level. Drives the
 * persistent low-stock banner (`<LowStockBanner>`, design.md > "POS UI")
 * which is visible on every screen for both Admin and Cashier roles
 * (Req 3.6). The query touches only the `Inventory` (PK) and
 * `Product` (PK + `reorderLevel` column) tables — both indexed point
 * reads on the join — and runs in O(N) over distinct products, which
 * for the V1 catalog size (low thousands) finishes well under the
 * 100 ms target for non-list channels.
 *
 * Returns `Ok({ count })`. Never errors at the wire boundary: a SQLite
 * failure here would propagate as `INTERNAL` via the router's
 * try/catch, but the query has no user input that could surface a
 * `VALIDATION` envelope.
 *
 * Validates: Requirements 3.6.
 */
async function lowStockCount(): Promise<Result<{ count: number }>> {
  const rows = await prisma.$queryRaw<{ count: number | bigint }[]>(
    Prisma.sql`SELECT COUNT(*) AS count
                 FROM "Inventory" i
                 JOIN "Product" p ON p."id" = i."productId"
                WHERE i."onHand" <= p."reorderLevel"`,
  );
  // SQLite returns COUNT(*) as a number when small but Prisma may
  // surface it as a bigint on larger result sets; normalize both into
  // a plain JS number so the wire envelope stays JSON-clean.
  const raw = rows[0]?.count ?? 0;
  const count = typeof raw === 'bigint' ? Number(raw) : raw;
  return Ok({ count });
}

/**
 * Public list of products at or below their reorder level. Drives the
 * `reports:lowStock` channel which the renderer's banner click and
 * the daily summary export both consume (Req 9.3).
 *
 * Ordering: most-urgent first. Within the matched set, products with
 * the highest `reorderLevel` come first (a higher target makes the
 * gap to zero more pressing), ties broken by ascending `onHand` (the
 * lower the on-hand the more urgent), then by `name` so the order is
 * deterministic for the export. This matches the "most-urgent first"
 * convention used by the daily summary and gives Admin-facing
 * exports a stable rendering for snapshotting.
 *
 * Returns `Ok({ rows })` matching `IpcContract['reports:lowStock']`.
 * The `LowStockRow` shape carries `{ productId, sku, name, onHand,
 * reorderLevel }` — exactly the projection the export and the banner
 * need; no other product fields cross the wire here.
 *
 * Validates: Requirements 3.6, 9.3.
 */
async function lowStockList(): Promise<Result<{ rows: readonly LowStockRow[] }>> {
  // Project only the wire columns. Casting the SQL `ORDER BY` into the
  // query (rather than sorting in JS) keeps the work in SQLite, which
  // can hit the `Product` PK + `Inventory` PK without a temp sort for
  // the V1 catalog size. The `ASC NULLS LAST` semantics are not
  // applicable — none of the projected columns are nullable.
  const rows = await prisma.$queryRaw<
    {
      productId: string;
      sku: string;
      name: string;
      onHand: number;
      reorderLevel: number;
    }[]
  >(
    Prisma.sql`SELECT i."productId"     AS productId,
                      p."sku"           AS sku,
                      p."name"          AS name,
                      i."onHand"        AS onHand,
                      p."reorderLevel"  AS reorderLevel
                 FROM "Inventory" i
                 JOIN "Product" p ON p."id" = i."productId"
                WHERE i."onHand" <= p."reorderLevel"
                ORDER BY p."reorderLevel" DESC, i."onHand" ASC, p."name" ASC`,
  );

  // Map straight to the readonly DTO shape. Numeric columns come back
  // as JS numbers (Prisma coerces SQLite INTEGER → number for values
  // within the safe-integer range); guard with `Number()` so a future
  // change that returns BigInt does not silently break the wire.
  const dtoRows: LowStockRow[] = rows.map((row) => ({
    productId: row.productId,
    sku: row.sku,
    name: row.name,
    onHand: Number(row.onHand),
    reorderLevel: Number(row.reorderLevel),
  }));

  return Ok({ rows: dtoRows });
}

// ---------------------------------------------------------------------------
// InventoryService surface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Movement listing (Phase 5, task 5.5.1) — Req 3.1, 16.1, 16.2, 16.3, 16.4
// ---------------------------------------------------------------------------
//
// `listMovements` and `countMovements` drive the Admin-only inventory
// movement browser (`inventory_movements:list` / `..:count`). Both
// channels share the same `MovementFilter` shape: optional `productId`,
// `movementType`, and an inclusive `[dateFrom, dateTo]` window against
// the row's `timestamp`. The list is cursor-paginated by
// `(timestamp DESC, id)` — the composite index declared on the
// `InventoryMovement` model in `prisma/schema.prisma` (Req 15.4, 16.4)
// is the seek target the SQLite planner uses for both predicates and
// for the keyset ordering.
//
// Pagination goes through the shared `paginateCursor` helper
// (`src/main/db/paginate.ts`, task 2.5.1) — the same helper every other
// time-typed list channel uses, so the cursor format, page-size
// clamping, and `withCount` opt-in stay consistent across channels.
// `paginateCursor` operates on the structural `PaginateModel` shape
// (`findMany` + `count`); we wrap `prisma.inventoryMovement` so the
// helper's `findMany` call automatically adds the `Product` + `User`
// joins needed to project `productName` and `userName` onto the wire
// DTO without an N+1 follow-up. The wrapper keeps the helper's input
// surface untouched (no need to widen `PaginateFindManyArgs` with
// an `include` field).

/**
 * Movement row shape returned by `inventoryMovement.findMany` once the
 * `Product` and `User` joins are attached. Local interface — Prisma's
 * generated payload types are noisy enough that the explicit shape is
 * easier to read here, and the joins are stable enough that the type
 * doesn't drift.
 */
type MovementRowWithRelations = InventoryMovement & {
  product: { name: string };
  user: { username: string };
};

/** Default ISO 8601 sentinel timestamps used when only one bound is supplied. */
const MIN_TS = new Date('1970-01-01T00:00:00.000Z');
const MAX_TS = new Date('9999-12-31T23:59:59.999Z');

/**
 * Compile the renderer-supplied `MovementFilter` into a Prisma-style
 * where shape suitable for both `paginateCursor` (which forwards it to
 * `findMany`) and the companion `count` call.
 *
 * Rules:
 *   - `productId`     → exact match. Empty / non-string values are
 *                       ignored (the renderer should not be sending
 *                       them, but we don't surface VALIDATION here
 *                       because the channel contract types it as a
 *                       non-empty string already).
 *   - `movementType`  → exact match against the discriminator column.
 *   - `dateFrom` / `dateTo` → inclusive `[gte, lte]` window against
 *                       `timestamp`. Either bound may be omitted; the
 *                       missing side is filled in with a sentinel so a
 *                       single-sided window still serializes as a
 *                       range predicate (lets the SQLite planner pick
 *                       the composite cursor index regardless of which
 *                       side is bounded).
 *
 * Invalid date strings are tolerated by silently dropping the offending
 * bound — the renderer's date-picker is responsible for producing
 * well-formed ISO strings, so a malformed value here is a programmer
 * bug, not user input.
 */
function compileMovementWhere(filter: MovementFilter | undefined): PaginateWhere {
  const where: Record<string, unknown> = {};

  if (filter === undefined) return where;

  if (typeof filter.productId === 'string' && filter.productId.length > 0) {
    where.productId = filter.productId;
  }

  if (typeof filter.movementType === 'string' && filter.movementType.length > 0) {
    where.movementType = filter.movementType;
  }

  const dateFrom = parseIsoDateOrUndefined(filter.dateFrom);
  const dateTo = parseIsoDateOrUndefined(filter.dateTo);
  if (dateFrom !== undefined || dateTo !== undefined) {
    where.timestamp = {
      gte: dateFrom ?? MIN_TS,
      lte: dateTo ?? MAX_TS,
    };
  }

  return where;
}

/** Parse an optional ISO 8601 string. Returns `undefined` for missing
 *  or unparseable input. */
function parseIsoDateOrUndefined(value: string | undefined): Date | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

/**
 * Wrap `prisma.inventoryMovement` so it satisfies the structural
 * `PaginateModel<MovementRowWithRelations>` contract while transparently
 * attaching the `Product` + `User` joins on every `findMany` call.
 *
 * `paginateCursor` only forwards `where`, `orderBy`, and `take` — adding
 * `include` here keeps the joined columns coming out of the cursor
 * helper without expanding its public surface. The wrapper also pins
 * the row type to `MovementRowWithRelations` so the DTO mapper does not
 * have to re-narrow.
 */
function makePaginatedMovementModel(): PaginateModel<MovementRowWithRelations> {
  const include = {
    product: { select: { name: true } },
    user: { select: { username: true } },
  } as const satisfies Prisma.InventoryMovementInclude;

  const model: PaginateModel<MovementRowWithRelations> = {
    async findMany(args) {
      const findArgs: Prisma.InventoryMovementFindManyArgs = {
        orderBy: args.orderBy as unknown as Prisma.InventoryMovementOrderByWithRelationInput[],
        take: args.take,
        include,
        ...(args.where !== undefined ? { where: args.where } : {}),
      };
      const rows = await prisma.inventoryMovement.findMany(findArgs);
      return rows as MovementRowWithRelations[];
    },
    count(args) {
      const countArgs: Prisma.InventoryMovementCountArgs =
        args.where !== undefined ? { where: args.where } : {};
      return prisma.inventoryMovement.count(countArgs);
    },
  };
  return model;
}

/**
 * Project a joined `InventoryMovement` row onto the cross-process
 * `InventoryMovementDTO`. `timestamp` is normalized to ISO 8601 so the
 * wire format is canonical and the renderer never has to handle a
 * `Date` instance crossing the IPC boundary.
 */
function toMovementDTO(row: MovementRowWithRelations): InventoryMovementDTO {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.product.name,
    quantityDelta: row.quantityDelta,
    movementType: row.movementType as MovementType,
    referenceType: row.referenceType as ReferenceType,
    referenceId: row.referenceId,
    userId: row.userId,
    userName: row.user.username,
    timestamp: row.timestamp.toISOString(),
  };
}

/**
 * Cursor-paginated movement list (`inventory_movements:list`).
 *
 * Behaviour:
 *   1. Filter (`productId`, `movementType`, `dateFrom`/`dateTo`) is
 *      compiled to a Prisma where shape via `compileMovementWhere`.
 *   2. Pagination goes through the shared `paginateCursor` helper —
 *      page-size clamping, malformed-cursor → `Err('VALIDATION')`,
 *      `nextCursor` semantics, and `withCount` opt-in all match the
 *      cross-channel contract (Req 16.1–16.3).
 *   3. The cursor sort column is `timestamp`; ordering is the channel
 *      default `(timestamp DESC, id DESC)` so the composite index on
 *      `(timestamp DESC, id)` is hit (Req 16.4).
 *   4. Each row is mapped to `InventoryMovementDTO` with joined
 *      `productName` (from `Product.name`) and `userName` (from
 *      `User.username`) so renderer rendering does not need an N+1
 *      follow-up.
 *
 * Search is intentionally not part of the channel contract — the
 * Admin-facing browser exposes filters only (movement type, product,
 * date range). The companion `countMovements` mirrors the same filter
 * shape so paginated totals stay consistent.
 *
 * Validates: Requirements 3.1, 16.1, 16.2, 16.3, 16.4.
 */
async function listMovements(
  req: ListRequest<MovementFilter, MovementSortKey>,
): Promise<Result<ListResponse<InventoryMovementDTO>>> {
  const where = compileMovementWhere(req.filter);
  const direction: 'desc' | 'asc' = req.sort?.dir ?? 'desc';

  const paginateOpts = {
    model: makePaginatedMovementModel(),
    sortColumn: 'timestamp',
    direction,
    ...(Object.keys(where).length > 0 ? { where } : {}),
    ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
    ...(req.pageSize !== undefined ? { pageSize: req.pageSize } : {}),
    ...(req.withCount === true ? { withCount: true as const } : {}),
  };

  const result = await paginateCursor(paginateOpts);
  if (!result.ok) {
    return result;
  }

  const dtoRows = result.value.rows.map(toMovementDTO);
  const response: ListResponse<InventoryMovementDTO> =
    result.value.totalCount !== undefined
      ? { rows: dtoRows, nextCursor: result.value.nextCursor, totalCount: result.value.totalCount }
      : { rows: dtoRows, nextCursor: result.value.nextCursor };
  return Ok(response);
}

/**
 * Companion total-count for `inventory_movements:list`. Wired to
 * `inventory_movements:count` and consumed by the Admin browser's
 * totals strip (Req 16.1, 16.2). The wire request shape is
 * `{ filter?, search? }` for parity with every other count channel —
 * `search` is currently unused on this channel (the list does not
 * accept a search term either) but keeping the parameter in the
 * signature lets a future text-search filter slot in without changing
 * the IPC contract.
 *
 * Validates: Requirements 16.1, 16.2.
 */
async function countMovements(
  req: { filter?: MovementFilter; search?: string },
): Promise<Result<{ totalCount: number }>> {
  const where = compileMovementWhere(req.filter) as Prisma.InventoryMovementWhereInput;
  const totalCount = await prisma.inventoryMovement.count({ where });
  return Ok({ totalCount });
}

// ---------------------------------------------------------------------------
// InventoryService surface
// ---------------------------------------------------------------------------

/**
 * Inventory service surface. Exposed as a frozen object literal so
 * callers import a single named symbol; the IPC handler module wires
 * each method to its channel without instantiating a class. Matches
 * the convention established by `AuthService`, `CategoryService`, and
 * `ProductService`.
 *
 * Phase 5 task 5.1 exposes the internal ledger-writer helper
 * `applyMovement` so other services in this phase (purchase, pos) can
 * call into the inventory module via this single import without
 * reaching into the helper's source file directly.
 *
 * Phase 5 task 5.2 adds `adjust(...)` — the public manual-adjustment
 * entry point that opens its own `$transaction`, calls
 * `applyMovement`, and writes the matching `audit_logs` +
 * `journal_entries` rows atomically.
 *
 * Phase 5 task 5.3 adds `lowStockCount()` and `lowStockList()` for the
 * dashboard banner and the daily summary export (Req 3.6).
 *
 * Phase 5 task 5.5.1 (this task) adds `listMovements` and
 * `countMovements` for the Admin-only inventory movement browser
 * (`inventory_movements:list` / `..:count`).
 */
export const InventoryService = Object.freeze({
  applyMovement,
  adjust,
  lowStockCount,
  lowStockList,
  listMovements,
  countMovements,
} as const);
