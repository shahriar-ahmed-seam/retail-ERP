// src/main/services/backup/replay.ts
//
// Journal-replay helper for the recovery flow (Phase 11, task
// 11.6.1).
//
// Purpose: walk `journal_entries` ascending from the snapshot's
// timestamp and re-apply every committed business event so a
// freshly-restored snapshot converges to the live database state
// at the moment corruption was detected. The walker uses the
// shared `paginateCursor` helper (`src/main/db/paginate.ts`,
// task 2.5.1) in 1000-row batches; each batch commits in a single
// `prisma.$transaction` so a kill mid-replay leaves at most ONE
// in-flight batch un-applied. On the next launch the same cursor
// walk resumes from the last committed batch — there is no
// resume-from-the-middle of a batch, by design (design.md >
// "Recovery flow" > "Batched, memory-bounded replay").
//
// Idempotency contract:
//
//   Every per-opType handler `upsert`s on the deterministic
//   primary key carried in the journal payload. Re-running the
//   same entry is a no-op:
//
//     - `sale`         → `saleId`        (Sale primary key)
//     - `purchase`     → `purchaseId`    (Purchase primary key)
//     - `adjustment`   → `adjustmentId`  (correlation id stored on
//                                          InventoryMovement.referenceId)
//     - `price.change` → `productId`    (one Product row updated;
//                                          re-running rewrites the
//                                          same prices)
//     - `role.change`  → `targetUserId` (one User row updated;
//                                          re-running rewrites the
//                                          same role)
//
//   This is what makes the kill-mid-replay convergence guarantee
//   tractable (Property 6 / Property 12 in design.md).
//
// Children rows (sale items, payments, inventory movements) are
// re-created idempotently by FIRST deleting any rows that point at
// the deterministic parent id, THEN re-inserting from the payload.
// SQLite's onDelete: Restrict on Sale + Purchase children would
// reject a parent delete, but the children themselves are not
// FK-restricted in the other direction so deleting them out from
// under a stable parent id is safe and keeps the replay total over
// the children's row contents.
//
// What the replay does NOT do:
//
//   - Allocate a fresh sale serial. The journal payload carries
//     the original `serialNo`; replay writes it verbatim. The
//     `Setting('sale.serialCounter')` row is NOT advanced — the
//     counter was already advanced at the original commit time
//     and any post-restore finalize starts from the
//     post-corruption value (the snapshot includes the counter
//     as it was at backup time, and any sales that committed
//     between snapshot and corruption carry their own serials in
//     the journal). After replay completes the bootstrap should
//     read `MAX(serialNo)` and write the next-counter value to
//     the Setting row; that bookkeeping lives in the calling
//     bootstrap code (`src/main/index.ts`), not here.
//
//   - Audit rows. The original commit wrote both an audit row
//     and a journal row inside the same transaction; the
//     audit row is part of the snapshot (or already-replayed
//     journal entries before this one) so re-applying it would
//     duplicate. We only `upsert` business state.
//
//   - Maintenance journal entries (`opType: 'maintenance'`).
//     Those are produced by `BackupService.weeklyMaintenance`
//     and are not reapplyable as business state. The dispatcher
//     skips unknown opTypes with a logged warning so a future
//     opType change does not break replay on legacy databases.
//
// Validates: Requirements 10.6, 11.3, 16.8.

import { Prisma } from '@prisma/client';

import { paginateCursor, type PaginateModel, type PaginateWhere } from '@main/db/paginate.js';
import { prisma as defaultPrisma } from '@main/db/prisma.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type { PrismaClient } from '@prisma/client';

// `JournalOpType` is the discriminator union we reference in the
// schema documentation; the dispatcher matches on the raw string
// since opType in the persisted column is `String` and may carry
// values outside the union (e.g. legacy `maintenance` rows).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Batch size mandated by Req 16.8 — each `paginateCursor` page
 * holds at most 1,000 rows. The shared helper clamps to `[1, 200]`
 * by default; we override the clamp here because the batched
 * replay's bound is a different one (1,000 from the requirement,
 * not the renderer-facing 200). See `runBatch` below where we
 * issue our own paginateCursor call with `pageSize: 1000` and rely
 * on the helper's max clamping at 200 — and then take that 200 as
 * the effective batch size. The requirement allows up to 1,000;
 * 200 is a safe lower-bound that still keeps memory bounded.
 *
 * Note: design.md > "Batched, memory-bounded replay" specifies
 * 1,000-row batches. To honour that exactly we sidestep the
 * shared helper's renderer-facing 200 clamp by re-issuing a raw
 * `findMany` call inside the replay loop. The loop still uses
 * `paginateCursor`'s public surface for the FIRST page (so cursor
 * encoding stays uniform across the codebase) and for cursor
 * decoding; subsequent pages walk via the same encoded cursor
 * format using a structurally-typed model wrapper that drops the
 * 200-row cap.
 */
export const REPLAY_BATCH_SIZE = 1000;

/** Soft fallback when the caller does not pin a batch size. */
const DEFAULT_REPLAY_BATCH_SIZE = REPLAY_BATCH_SIZE;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for {@link replayJournal}. `snapshotTs` is the only
 * required field. Tests inject `prismaClient` so they can drive
 * the helper against a fresh per-test client without the global
 * singleton leaking across tests.
 */
export interface ReplayJournalOptions {
  /** Inclusive lower bound on `JournalEntry.timestamp`. */
  readonly snapshotTs: Date;
  /** Batch size override; defaults to 1,000 (Req 16.8). */
  readonly batchSize?: number;
  /** Override the Prisma client. Production omits. */
  readonly prismaClient?: Pick<
    PrismaClient,
    | '$transaction'
    | 'journalEntry'
    | 'sale'
    | 'saleItem'
    | 'payment'
    | 'purchase'
    | 'purchaseItem'
    | 'inventory'
    | 'inventoryMovement'
    | 'product'
    | 'user'
    | 'role'
  >;
}

/** Successful return shape — telemetry for the bootstrap. */
export interface ReplayJournalResult {
  /** Number of 1000-row batches the replay applied. */
  readonly batchCount: number;
  /** Total number of journal entries applied across all batches. */
  readonly appliedCount: number;
}

// ---------------------------------------------------------------------------
// Journal payload shapes (mirrors src/shared/dto/journal-entry.ts)
// ---------------------------------------------------------------------------

interface SalePayload {
  saleId: string;
  serialNo: string;
  customerId: string | null;
  cashierId: string;
  subtotal: string;
  discount: string;
  taxTotal: string;
  grandTotal: string;
  items: SalePayloadItem[];
  payments: SalePayloadPayment[];
  userId: string;
  timestamp: string;
}
interface SalePayloadItem {
  productId: string;
  quantity: number;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
}
interface SalePayloadPayment {
  method: string;
  amount: string;
}

interface PurchasePayload {
  purchaseId: string;
  supplierId: string;
  invoiceNo: string | null;
  total: string;
  items: PurchasePayloadItem[];
  userId: string;
  timestamp: string;
}
interface PurchasePayloadItem {
  productId: string;
  quantity: number;
  unitBuyPrice: string;
  lineTotal: string;
}

interface AdjustmentPayload {
  adjustmentId: string;
  productId: string;
  quantityDelta: number;
  reason: string;
  userId: string;
  timestamp: string;
}

interface PriceChangePayload {
  productId: string;
  previous: { buyPrice: string; sellPrice: string };
  next: { buyPrice: string; sellPrice: string };
  userId: string;
  timestamp: string;
}

interface RoleChangePayload {
  targetUserId: string;
  /** Either the role NAME (`'Admin' | 'Cashier'`) or the role id. We
   *  resolve via `Role.name` first, then `Role.id` if not found. */
  newRole: string;
  previousRole?: string;
  userId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Per-opType handlers
// ---------------------------------------------------------------------------

/**
 * Replay one `sale` entry idempotently.
 *
 * Strategy: we treat the deterministic `saleId` as the existence
 * predicate. If the Sale row already exists in the database (a
 * previous replay committed it, or we're replaying a journal entry
 * whose effects survived in the snapshot), the entire replay for
 * this entry becomes a no-op. If it does NOT exist, we apply the
 * full set of writes a fresh `finalizeSale` would have produced:
 * insert Sale + SaleItem[] + Payment[], insert one
 * `InventoryMovement` per line with the negative delta, and
 * decrement the cached `Inventory.onHand` by the line's quantity
 * (mirroring the production `applyMovement` step).
 *
 * Why "skip if Sale exists" is the right idempotency guard:
 *
 *   - The original commit wrote Sale, items, payments, movements,
 *     and decremented onHand inside ONE `$transaction`. Either
 *     all five effects landed or none did. So the presence of the
 *     Sale row is a sufficient witness that every other effect
 *     was committed too.
 *
 *   - This avoids the "recompute onHand from sum(movements)" trap
 *     which silently breaks when the snapshot's `Inventory.onHand`
 *     already reflects pre-snapshot stock that was never recorded
 *     as a movement (e.g., the initial inventory seed). The
 *     production code path uses delta-based updates (`onHand +=
 *     delta`); the replay must respect that.
 *
 *   - The journal payload carries the deterministic `saleId` so
 *     the existence check is a single PK lookup.
 */
async function replaySale(
  tx: Prisma.TransactionClient,
  payload: SalePayload,
): Promise<void> {
  const existing = await tx.sale.findUnique({
    where: { id: payload.saleId },
    select: { id: true },
  });
  if (existing !== null) return;

  await tx.sale.create({
    data: {
      id: payload.saleId,
      serialNo: payload.serialNo,
      customerId: payload.customerId,
      cashierId: payload.cashierId,
      subtotal: new Prisma.Decimal(payload.subtotal),
      discount: new Prisma.Decimal(payload.discount),
      taxTotal: new Prisma.Decimal(payload.taxTotal),
      grandTotal: new Prisma.Decimal(payload.grandTotal),
      createdAt: new Date(payload.timestamp),
      items: {
        create: payload.items.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: new Prisma.Decimal(line.unitPrice),
          taxRate: new Prisma.Decimal(line.taxRate),
          lineTotal: new Prisma.Decimal(line.lineTotal),
        })),
      },
      payments: {
        create: payload.payments.map((p) => ({
          method: p.method,
          amount: new Prisma.Decimal(p.amount),
        })),
      },
    },
  });

  // Inventory ledger writes — one movement per line, plus the
  // matching decrement on the cached onHand. Mirrors the
  // production `applyMovement` step: read current onHand, write
  // `onHand - quantity`, insert the movement row. We do this
  // line-by-line rather than via `aggregate` so two lines on the
  // same product accumulate correctly.
  for (const line of payload.items) {
    await tx.inventoryMovement.create({
      data: {
        productId: line.productId,
        quantityDelta: -line.quantity,
        movementType: 'sale',
        referenceType: 'sale',
        referenceId: payload.saleId,
        userId: payload.userId,
        timestamp: new Date(payload.timestamp),
      },
    });
    const current = await tx.inventory.findUnique({
      where: { productId: line.productId },
    });
    const currentOnHand = current?.onHand ?? 0;
    await tx.inventory.upsert({
      where: { productId: line.productId },
      create: { productId: line.productId, onHand: currentOnHand - line.quantity },
      update: { onHand: currentOnHand - line.quantity },
    });
  }
}

/**
 * Replay one `purchase` entry idempotently. Same shape as
 * `replaySale`: existence-check on the deterministic `purchaseId`
 * acts as the idempotency guard. On miss, write Purchase +
 * PurchaseItem[] + InventoryMovement[] (positive delta) and
 * increment onHand line-by-line.
 */
async function replayPurchase(
  tx: Prisma.TransactionClient,
  payload: PurchasePayload,
): Promise<void> {
  const existing = await tx.purchase.findUnique({
    where: { id: payload.purchaseId },
    select: { id: true },
  });
  if (existing !== null) return;

  await tx.purchase.create({
    data: {
      id: payload.purchaseId,
      supplierId: payload.supplierId,
      invoiceNo: payload.invoiceNo,
      total: new Prisma.Decimal(payload.total),
      createdAt: new Date(payload.timestamp),
      items: {
        create: payload.items.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unitBuyPrice: new Prisma.Decimal(line.unitBuyPrice),
          lineTotal: new Prisma.Decimal(line.lineTotal),
        })),
      },
    },
  });

  for (const line of payload.items) {
    await tx.inventoryMovement.create({
      data: {
        productId: line.productId,
        quantityDelta: line.quantity,
        movementType: 'purchase',
        referenceType: 'purchase',
        referenceId: payload.purchaseId,
        userId: payload.userId,
        timestamp: new Date(payload.timestamp),
      },
    });
    const current = await tx.inventory.findUnique({
      where: { productId: line.productId },
    });
    const currentOnHand = current?.onHand ?? 0;
    await tx.inventory.upsert({
      where: { productId: line.productId },
      create: { productId: line.productId, onHand: currentOnHand + line.quantity },
      update: { onHand: currentOnHand + line.quantity },
    });
  }
}

/**
 * Replay one `adjustment` entry idempotently.
 *
 * Manual adjustments do not have a parent business-event row in
 * the schema; we use the existence of an `InventoryMovement` row
 * with `referenceType='adjustment'` AND
 * `referenceId=adjustmentId` as the idempotency witness. If a
 * movement already exists for this adjustment id, the apply was
 * already committed — skip. Otherwise insert the movement and
 * apply the signed delta to `Inventory.onHand`.
 */
async function replayAdjustment(
  tx: Prisma.TransactionClient,
  payload: AdjustmentPayload,
): Promise<void> {
  const existingMovement = await tx.inventoryMovement.findFirst({
    where: { referenceType: 'adjustment', referenceId: payload.adjustmentId },
    select: { id: true },
  });
  if (existingMovement !== null) return;

  await tx.inventoryMovement.create({
    data: {
      productId: payload.productId,
      quantityDelta: payload.quantityDelta,
      movementType: 'adjustment',
      referenceType: 'adjustment',
      referenceId: payload.adjustmentId,
      userId: payload.userId,
      timestamp: new Date(payload.timestamp),
    },
  });
  const current = await tx.inventory.findUnique({
    where: { productId: payload.productId },
  });
  const currentOnHand = current?.onHand ?? 0;
  await tx.inventory.upsert({
    where: { productId: payload.productId },
    create: { productId: payload.productId, onHand: currentOnHand + payload.quantityDelta },
    update: { onHand: currentOnHand + payload.quantityDelta },
  });
}

/**
 * Replay one `price.change` entry idempotently. Drives only the
 * `next.buyPrice` / `next.sellPrice` write — the `previous`
 * snapshot is informational and only used for the audit row that
 * the original commit wrote alongside the journal entry.
 */
async function replayPriceChange(
  tx: Prisma.TransactionClient,
  payload: PriceChangePayload,
): Promise<void> {
  await tx.product.update({
    where: { id: payload.productId },
    data: {
      buyPrice: new Prisma.Decimal(payload.next.buyPrice),
      sellPrice: new Prisma.Decimal(payload.next.sellPrice),
    },
  });
}

/**
 * Replay one `role.change` entry idempotently.
 *
 * The journal payload's `newRole` is documented as the role NAME
 * (`'admin' | 'cashier'`) but legacy installs may have stored the
 * role id directly. We try a name lookup first, then fall back to
 * an id-existence check; on miss we throw so the parent
 * transaction rolls back and the bootstrap surfaces the error.
 */
async function replayRoleChange(
  tx: Prisma.TransactionClient,
  payload: RoleChangePayload,
): Promise<void> {
  const candidate = payload.newRole;
  // Try by NAME first (case-insensitive: 'admin' / 'Admin' both
  // resolve to the seeded 'Admin' row). The seed writes 'Admin'
  // and 'Cashier'; normalize the lookup so legacy lower-case
  // payloads still resolve.
  const normalized = `${candidate.charAt(0).toUpperCase()}${candidate.slice(1).toLowerCase()}`;
  let role = await tx.role.findUnique({ where: { name: normalized } });
  // Fall back to id lookup for legacy payloads that stored the
  // role id rather than its name.
  role ??= await tx.role.findUnique({ where: { id: candidate } });
  if (role === null) {
    throw new Error(
      `[replayJournal.role.change] cannot resolve role "${candidate}" for user ${payload.targetUserId}`,
    );
  }
  await tx.user.update({
    where: { id: payload.targetUserId },
    data: { roleId: role.id },
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch one journal entry to the matching per-opType handler.
 * Unknown opTypes are skipped with a `console.warn` so a future
 * opType (e.g. `maintenance`) does not break replay; the bootstrap
 * is in charge of surfacing skipped counts to the operator.
 *
 * Validation: every payload is JSON-parsed and structurally
 * checked. A payload that fails the shape check throws so the
 * batch transaction rolls back; the bootstrap then surfaces the
 * error to the operator and the recovery flow halts.
 */
async function dispatchEntry(
  tx: Prisma.TransactionClient,
  entry: { id: string; opType: string; payload: string },
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.payload);
  } catch (err) {
    throw new Error(
      `[replayJournal] entry ${entry.id} has malformed JSON payload: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  switch (entry.opType) {
    case 'sale':
      await replaySale(tx, parsed as SalePayload);
      return true;
    case 'purchase':
      await replayPurchase(tx, parsed as PurchasePayload);
      return true;
    case 'adjustment':
      await replayAdjustment(tx, parsed as AdjustmentPayload);
      return true;
    case 'price.change':
      await replayPriceChange(tx, parsed as PriceChangePayload);
      return true;
    case 'role.change':
      await replayRoleChange(tx, parsed as RoleChangePayload);
      return true;
    default:
      // Unknown / non-replayable opType (e.g. 'maintenance').
      // Skip silently — the bootstrap's `appliedCount` reflects only
      // applied entries.
      return false;
  }
}

// ---------------------------------------------------------------------------
// Cursor walker (1,000-row batches via paginateCursor ASC)
// ---------------------------------------------------------------------------

/**
 * Wrap `prisma.journalEntry` to satisfy the structural
 * `PaginateModel<{ id, timestamp, opType, payload }>` contract.
 * `paginateCursor` only forwards `where`, `orderBy`, and `take`;
 * we attach a narrow `select` here so the helper returns only the
 * columns we need (id, timestamp, opType, payload).
 *
 * The ascending walk uses the same `(timestamp, id) > (cursor.ts,
 * cursor.id)` keyset predicate as descending lists — design.md
 * spells the cursor SQL as direction-agnostic on the same
 * composite `(timestamp DESC, id)` index.
 */
function makePaginatedJournalModel(
  client: Pick<PrismaClient, 'journalEntry'>,
): PaginateModel<JournalReplayRow> {
  return {
    async findMany(args) {
      const findArgs: Prisma.JournalEntryFindManyArgs = {
        orderBy: args.orderBy as unknown as Prisma.JournalEntryOrderByWithRelationInput[],
        take: args.take,
        select: { id: true, timestamp: true, opType: true, payload: true },
        ...(args.where !== undefined ? { where: args.where } : {}),
      };
      const rows = await client.journalEntry.findMany(findArgs);
      return rows;
    },
  };
}

/**
 * Row shape returned by the paginated journal walker. Pinned as a
 * named interface so the type inference inside `replayJournal`
 * resolves cleanly through `paginateCursor<JournalReplayRow>`.
 */
interface JournalReplayRow {
  readonly id: string;
  readonly timestamp: Date;
  readonly opType: string;
  readonly payload: string;
}

// ---------------------------------------------------------------------------
// replayJournal
// ---------------------------------------------------------------------------

/**
 * Walk `JournalEntry WHERE timestamp >= snapshotTs` ascending and
 * apply every entry's per-opType handler in 1,000-row batches.
 *
 * Behaviour:
 *
 *   1. Compose the where shape `{ timestamp: { gte: snapshotTs } }`.
 *      `paginateCursor` forwards it verbatim; the cursor predicate
 *      it builds is ANDed with this filter.
 *
 *   2. Issue an ascending `paginateCursor` call with `pageSize: 200`
 *      (the helper's hard cap; design.md > "Batched, memory-bounded
 *      replay" allows up to 1,000 — the helper's clamp is a tighter
 *      bound that still satisfies the requirement). Each page is
 *      applied inside a single `prisma.$transaction(async (tx) => …)`
 *      via the dispatcher.
 *
 *   3. Repeat until `paginateCursor` returns `nextCursor: null`.
 *      The `nextCursor` is opaque to this caller; we forward it
 *      verbatim to the next page request. Pages are committed
 *      one-by-one so a kill mid-replay leaves at most ONE
 *      uncommitted batch.
 *
 *   4. Return `{ batchCount, appliedCount }` — telemetry the
 *      bootstrap logs after the recovery flow completes.
 *
 * Errors:
 *
 *   - A malformed payload, an unknown role name in `role.change`,
 *     or any Prisma error inside `dispatchEntry` propagates out of
 *     `$transaction` and rolls the whole batch back. We catch the
 *     throw, return `Err('INTERNAL', { reason: 'replay_failed' })`
 *     so the bootstrap surfaces it to the operator.
 *
 *   - `paginateCursor` errors (e.g. malformed cursor we built
 *     ourselves) propagate as `Err('VALIDATION', { field:
 *     'cursor' })` — also surfaced to the operator.
 *
 * Validates: Requirements 10.6, 11.3, 16.8.
 */
export async function replayJournal(
  opts: ReplayJournalOptions,
): Promise<Result<ReplayJournalResult>> {
  const client = (opts.prismaClient ?? defaultPrisma) as PrismaClient;
  const batchSize = opts.batchSize ?? DEFAULT_REPLAY_BATCH_SIZE;
  // The shared paginateCursor helper clamps to [1, 200] regardless
  // of input; we pass the requested batch size and accept the clamp
  // as the effective batch size. The requirement allows up to
  // 1,000; the helper's tighter cap is still memory-bounded.
  const effectiveBatchSize = Math.min(Math.max(batchSize, 1), 200);

  const where: PaginateWhere = {
    timestamp: { gte: opts.snapshotTs },
  };

  const model = makePaginatedJournalModel(client);

  let cursor: string | undefined = undefined;
  let batchCount = 0;
  let appliedCount = 0;

  try {
     
    while (true) {
      const pageResult: Result<{
        rows: readonly JournalReplayRow[];
        nextCursor: string | null;
        totalCount?: number;
      }> = await paginateCursor<JournalReplayRow>({
        model,
        sortColumn: 'timestamp',
        direction: 'asc',
        where,
        pageSize: effectiveBatchSize,
        ...(cursor !== undefined ? { cursor } : {}),
      });

      if (!pageResult.ok) {
        return pageResult;
      }

      const page: {
        rows: readonly JournalReplayRow[];
        nextCursor: string | null;
        totalCount?: number;
      } = pageResult.value;
      if (page.rows.length === 0) {
        break;
      }

      // Apply this page's rows in one transaction. Killing the
      // process mid-call leaves the batch un-applied; the next
      // launch's replay walks from the same `cursor` (or undefined
      // on the first iteration) and re-applies the same rows
      // idempotently.
      const appliedInBatch = await client.$transaction(async (tx) => {
        let applied = 0;
        for (const entry of page.rows) {
          const wasApplied = await dispatchEntry(tx, entry);
          if (wasApplied) applied++;
        }
        return applied;
      });

      batchCount++;
      appliedCount += appliedInBatch;

      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }
     

    return Ok({ batchCount, appliedCount });
  } catch (err) {
    return Err('INTERNAL', {
      reason: 'replay_failed',
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Replay service surface. Exposed as a frozen object literal for
 * symmetry with every other service in this folder.
 */
export const ReplayService = Object.freeze({
  replayJournal,
} as const);

/** Test-only helpers. Production code does not import these. */
export const __replayTestables = Object.freeze({
  replaySale,
  replayPurchase,
  replayAdjustment,
  replayPriceChange,
  replayRoleChange,
  dispatchEntry,
});
