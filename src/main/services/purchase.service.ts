// src/main/services/purchase.service.ts
//
// Purchase domain service — atomic create + cursor-paginated listing
// (Phase 6, task 6.2).
//
// Responsibilities:
//   - `create(input, ctx)` → opens one `prisma.$transaction` and writes
//        (1) the `Purchase` header,
//        (2) one `PurchaseItem` row per line with
//            `lineTotal = quantity * unitBuyPrice`,
//        (3) one positive-delta `InventoryMovement` per line via
//            `applyMovement(tx, …)` (which also updates the cached
//            `Inventory.onHand`),
//        (4) one `JournalEntry` row of `opType: 'purchase'` carrying a
//            replay-friendly snapshot of the committed event.
//      Per Req 5.1 + 5.5 + 11.2 the four writes share one transaction;
//      a failure on any step rolls every preceding write back. Maps
//      Prisma's known errors to wire envelopes:
//        - `P2003` (FK violation, e.g. unknown `supplierId` /
//          `productId`) → `Err('FK_VIOLATION', { reason: 'not_found' })`.
//        - `P2025` (record not found, raised by `applyMovement`'s
//          `findUniqueOrThrow` against `Inventory(productId)` when the
//          product is unknown) → `Err('FK_VIOLATION',
//          { reason: 'not_found' })`. Treated identically to P2003 for
//          this service because the only way either surfaces here is
//          a missing FK target (supplier or product).
//      `OutOfStockError` cannot occur on the increment path — every
//      line's delta is positive — but if it ever does (defensive), the
//      caller's transaction handles the rollback and the IPC router
//      maps the propagating throw to `Err('INTERNAL', { errorId })`.
//
//   - `list(req)` → cursor-paginated purchase list via the shared
//        `paginateCursor` helper. Sort column is `createdAt`
//        (composite index `(createdAt DESC, id)` is the seek target);
//        filter shape is `{ supplierId?, dateFrom?, dateTo? }` per
//        `PurchasesFilter`. Each row is projected onto the
//        `PurchaseSummaryDTO` wire shape with joined `Supplier.name`
//        and `_count.items` so the renderer renders each row without
//        an N+1 follow-up. Mirrors the inventory-service movement-list
//        wrapper pattern exactly (the wrapper attaches `include`
//        without widening `paginateCursor`'s public surface).
//
//   - `count(req)` → companion `{ totalCount }` for the same filter
//        shape used by `list`. Wired to `purchases:count`.
//
// No audit rows are emitted by this service — purchase writes are
// not part of the audit-tracked surface in design.md (the audit log
// covers price changes, role changes, stock adjustments, and RBAC
// denials; purchase events are reconstructible from the
// `journal_entries` row written inline below).
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 6.3, 11.2,
//            16.1, 16.2, 16.3, 16.4.

import { Prisma, type Purchase } from '@prisma/client';

import { paginateCursor, type PaginateModel, type PaginateWhere } from '@main/db/paginate.js';
import { prisma } from '@main/db/prisma.js';
import { applyMovement } from '@main/services/inventory.service.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type {
  PurchaseInput,
  PurchaseItemInput,
  PurchaseSummaryDTO,
  PurchasesFilter,
  PurchasesSortKey,
} from '@shared/dto/index.js';
import type { ListRequest, ListResponse } from '@shared/ipc-contract.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Application-level bound on `Purchase.invoiceNo` (trimmed; optional). */
const INVOICE_NO_MAX = 50;

/** Prisma's known-error codes we map to envelope codes. */
const PRISMA_FK_VIOLATION = 'P2003';
const PRISMA_RECORD_NOT_FOUND = 'P2025';

/** Default ISO 8601 sentinel timestamps used when only one bound is supplied
 *  on the `dateFrom`/`dateTo` filter — same pattern as inventory.service. */
const MIN_TS = new Date('1970-01-01T00:00:00.000Z');
const MAX_TS = new Date('9999-12-31T23:59:59.999Z');

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the optional `invoiceNo` field. Returns:
 *   - `{ kind: 'set', value: string | null }` for valid input
 *     (whitespace-only collapses to `null`),
 *   - `'invalid'` when the input is the wrong shape or over-bound.
 *
 * The DTO declares `invoiceNo?: string | null`, so `undefined` and
 * `null` both mean "no invoice supplied" — both end up as `null` in
 * the persisted column.
 */
function validateInvoiceNo(value: unknown): { kind: 'set'; value: string | null } | 'invalid' {
  if (value === undefined || value === null) return { kind: 'set', value: null };
  if (typeof value !== 'string') return 'invalid';
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: 'set', value: null };
  if (trimmed.length > INVOICE_NO_MAX) return 'invalid';
  return { kind: 'set', value: trimmed };
}

/**
 * Validate one `PurchaseItemInput` and normalize its decimal price into
 * a `Prisma.Decimal`. Returns either the normalized line shape or the
 * offending field name so the caller can build an indexed
 * `items[N].<field>` error key.
 *
 * Rules (matched to Req 5.3 + the DTO declaration):
 *   - `productId` non-empty string,
 *   - `quantity` a finite integer ≥ 1 (zero/negative quantities have
 *     no business semantics on a purchase line),
 *   - `unitBuyPrice` a string that parses as a non-negative
 *     `Prisma.Decimal` (`'0'`, `'12.5'`, etc. are accepted; `NaN`,
 *     negative, and non-finite values are rejected).
 *
 * The decimal is constructed inside a try/catch because
 * `new Prisma.Decimal('NaN')` and similarly malformed inputs throw —
 * we surface those as a structured VALIDATION error rather than
 * letting an INTERNAL bubble out.
 */
function validateItem(
  item: PurchaseItemInput,
):
  | {
      ok: true;
      productId: string;
      quantity: number;
      unitBuyPrice: Prisma.Decimal;
      lineTotal: Prisma.Decimal;
    }
  | { ok: false; field: 'productId' | 'quantity' | 'unitBuyPrice' } {
  if (typeof item.productId !== 'string' || item.productId.length === 0) {
    return { ok: false, field: 'productId' };
  }

  if (
    typeof item.quantity !== 'number' ||
    !Number.isFinite(item.quantity) ||
    !Number.isInteger(item.quantity) ||
    item.quantity < 1
  ) {
    return { ok: false, field: 'quantity' };
  }

  if (typeof item.unitBuyPrice !== 'string' || item.unitBuyPrice.length === 0) {
    return { ok: false, field: 'unitBuyPrice' };
  }
  let unitBuyPrice: Prisma.Decimal;
  try {
    unitBuyPrice = new Prisma.Decimal(item.unitBuyPrice);
  } catch {
    return { ok: false, field: 'unitBuyPrice' };
  }
  // `Decimal.isFinite()` rejects NaN and ±Infinity; `lt(0)` rejects
  // negative amounts. Both forms are surfaced as a single VALIDATION
  // because the renderer only needs to mark the input.
  if (!unitBuyPrice.isFinite() || unitBuyPrice.lt(0)) {
    return { ok: false, field: 'unitBuyPrice' };
  }

  const lineTotal = unitBuyPrice.mul(item.quantity);
  return {
    ok: true,
    productId: item.productId,
    quantity: item.quantity,
    unitBuyPrice,
    lineTotal,
  };
}

// ---------------------------------------------------------------------------
// Filter compilation (list channel)
// ---------------------------------------------------------------------------

/**
 * Compile the renderer-supplied `PurchasesFilter` into a Prisma where
 * shape suitable for both `paginateCursor` (which forwards it to
 * `findMany`) and the companion `count` call.
 *
 * Rules:
 *   - `supplierId` → exact match. Empty / non-string values are
 *     ignored (the renderer should not be sending them).
 *   - `dateFrom` / `dateTo` → inclusive `[gte, lte]` window against
 *     `createdAt`. Either bound may be omitted; the missing side is
 *     filled in with a sentinel so a single-sided window still
 *     serializes as a range predicate (lets the SQLite planner pick
 *     the composite cursor index regardless of which side is bounded).
 *
 * Invalid date strings are tolerated by silently dropping the
 * offending bound — same convention as `inventory.service`'s
 * `compileMovementWhere`. The renderer's date-picker is responsible
 * for producing well-formed ISO strings, so a malformed value here is
 * a programmer bug, not user input.
 */
function compilePurchaseWhere(filter: PurchasesFilter | undefined): PaginateWhere {
  const where: Record<string, unknown> = {};

  if (filter === undefined) return where;

  if (typeof filter.supplierId === 'string' && filter.supplierId.length > 0) {
    where.supplierId = filter.supplierId;
  }

  const dateFrom = parseIsoDateOrUndefined(filter.dateFrom);
  const dateTo = parseIsoDateOrUndefined(filter.dateTo);
  if (dateFrom !== undefined || dateTo !== undefined) {
    where.createdAt = {
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

// ---------------------------------------------------------------------------
// DTO mapping (list channel)
// ---------------------------------------------------------------------------

/**
 * Purchase row shape returned by `purchase.findMany` once the
 * `Supplier` join + `_count` of items are attached. Local interface —
 * Prisma's generated payload types are noisy enough that the explicit
 * shape is easier to read here, and the joins are stable enough that
 * the type doesn't drift. Mirrors the `MovementRowWithRelations`
 * pattern in `inventory.service`.
 */
type PurchaseRowWithRelations = Purchase & {
  supplier: { name: string };
  _count: { items: number };
};

/**
 * Wrap `prisma.purchase` so it satisfies the structural
 * `PaginateModel<PurchaseRowWithRelations>` contract while transparently
 * attaching the `Supplier` + items-count joins on every `findMany`
 * call.
 *
 * `paginateCursor` only forwards `where`, `orderBy`, and `take` —
 * adding `include` here keeps the joined columns coming out of the
 * cursor helper without expanding its public surface. The wrapper
 * also pins the row type to `PurchaseRowWithRelations` so the DTO
 * mapper does not have to re-narrow.
 */
function makePaginatedPurchaseModel(): PaginateModel<PurchaseRowWithRelations> {
  const include = {
    supplier: { select: { name: true } },
    _count: { select: { items: true } },
  } as const satisfies Prisma.PurchaseInclude;

  const model: PaginateModel<PurchaseRowWithRelations> = {
    async findMany(args) {
      const findArgs: Prisma.PurchaseFindManyArgs = {
        orderBy: args.orderBy as unknown as Prisma.PurchaseOrderByWithRelationInput[],
        take: args.take,
        include,
        ...(args.where !== undefined ? { where: args.where } : {}),
      };
      const rows = await prisma.purchase.findMany(findArgs);
      return rows as PurchaseRowWithRelations[];
    },
    count(args) {
      const countArgs: Prisma.PurchaseCountArgs =
        args.where !== undefined ? { where: args.where } : {};
      return prisma.purchase.count(countArgs);
    },
  };
  return model;
}

/**
 * Project a joined `Purchase` row onto the cross-process
 * `PurchaseSummaryDTO`. `total` is stringified (the DTO contract
 * keeps decimals as strings end-to-end so the wire format is
 * round-trip-safe with `Prisma.Decimal`); `createdAt` is normalized
 * to ISO 8601 so the renderer never has to handle a `Date` instance
 * crossing the IPC boundary.
 */
function toPurchaseSummaryDTO(row: PurchaseRowWithRelations): PurchaseSummaryDTO {
  return {
    id: row.id,
    supplierId: row.supplierId,
    supplierName: row.supplier.name,
    invoiceNo: row.invoiceNo ?? null,
    total: row.total.toString(),
    itemCount: row._count.items,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// PurchaseService.create — atomic create (Req 5.1, 5.2, 5.3, 5.4, 5.5, 11.2)
// ---------------------------------------------------------------------------

/**
 * Atomic purchase create.
 *
 * Validates the input shape first, BEFORE opening any DB connection,
 * so the cheap rejections (empty items, bad quantity, bad price) never
 * touch SQLite. The remaining work is performed inside one
 * `prisma.$transaction` so the four writes — header, items, ledger
 * movements, journal — either all commit together or none of them do
 * (Req 5.5, 11.2).
 *
 * Order of operations inside the transaction:
 *
 *   1. `tx.purchase.create` — header. The Decimal `total` is computed
 *      as `sum(lineTotal)` over the validated lines.
 *   2. For each validated item, `tx.purchaseItem.create` carrying the
 *      pre-computed `lineTotal` (Req 5.3 — line_total identity).
 *   3. For each item, `applyMovement(tx, …)` with `delta: +quantity`,
 *      `movementType: 'purchase'`, `referenceType: 'purchase'`, and
 *      `referenceId: purchase.id`. This is what enforces Req 5.4 —
 *      every line increments on-hand stock — and the ledger
 *      invariant in design.md > "Inventory Ledger Invariant" by
 *      writing exactly one `InventoryMovement` per line in the same
 *      transaction.
 *   4. `tx.journalEntry.create` of `opType: 'purchase'` carrying a
 *      replay-friendly JSON snapshot of the committed event. The
 *      payload includes the purchaseId, supplierId, invoiceNo, total
 *      (stringified), the per-line {productId, quantity,
 *      unitBuyPrice, lineTotal} array, the acting userId, and an ISO
 *      timestamp captured at write time.
 *
 * Errors:
 *   - `Err('VALIDATION', { field })` for bad inputs. The `field`
 *     surface matches the renderer-facing path:
 *       * `'supplierId'` for an empty/missing supplier,
 *       * `'invoiceNo'` for a non-string or over-length invoice,
 *       * `'items'` for a missing/empty items array,
 *       * `'items[N].<key>'` for the first failing item, where `<key>`
 *         is `productId`, `quantity`, or `unitBuyPrice`.
 *   - `Err('FK_VIOLATION', { reason: 'not_found' })` when the
 *     `supplierId` or any `productId` is unknown. Both `P2003` and
 *     `P2025` map to this envelope:
 *       * `P2003` — SQLite FK violation on the `Purchase.supplierId`
 *         FK or the `PurchaseItem.productId` FK.
 *       * `P2025` — `applyMovement` calls `findUniqueOrThrow` against
 *         `Inventory(productId)` which throws P2025 when the product
 *         (and therefore its inventory row) is unknown.
 *   - Any other error propagates and the IPC router maps it to
 *     `Err('INTERNAL', { errorId })`.
 *
 * Returns `Ok({ purchaseId })` matching the `purchase:create` IPC
 * contract.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 11.2.
 */
async function create(
  input: PurchaseInput,
  ctx: { userId: string },
): Promise<Result<{ purchaseId: string }>> {
  // ---- Header validation -------------------------------------------------
  if (typeof input.supplierId !== 'string' || input.supplierId.length === 0) {
    return Err('VALIDATION', { field: 'supplierId' });
  }
  const supplierId = input.supplierId;

  const invoiceNoValidated = validateInvoiceNo(input.invoiceNo);
  if (invoiceNoValidated === 'invalid') {
    return Err('VALIDATION', { field: 'invoiceNo' });
  }
  const invoiceNo = invoiceNoValidated.value;

  // ---- Items validation --------------------------------------------------
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return Err('VALIDATION', { field: 'items' });
  }

  // Walk the items in order; first failure short-circuits with an
  // indexed `items[N].<field>` error key so the renderer can mark
  // exactly the offending row + cell.
  const validatedItems: {
    productId: string;
    quantity: number;
    unitBuyPrice: Prisma.Decimal;
    lineTotal: Prisma.Decimal;
  }[] = [];
  // The DTO declares `items` as `readonly PurchaseItemInput[]`, but
  // `Array.isArray` widens its narrowing to `any[]` under
  // `noUncheckedIndexedAccess`, so we re-bind through the typed
  // reference here to keep the loop body strongly-typed.
  const items = input.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as PurchaseItemInput;
    const result = validateItem(item);
    if (!result.ok) {
      return Err('VALIDATION', { field: `items[${i}].${result.field}` });
    }
    validatedItems.push({
      productId: result.productId,
      quantity: result.quantity,
      unitBuyPrice: result.unitBuyPrice,
      lineTotal: result.lineTotal,
    });
  }

  // Header total = sum(lineTotals). Computed via `Prisma.Decimal` so
  // we do not lose precision on amounts that don't round-trip through
  // float (e.g. `0.1 + 0.2 !== 0.3` in IEEE-754).
  const total = validatedItems.reduce(
    (acc, line) => acc.add(line.lineTotal),
    new Prisma.Decimal(0),
  );

  // ---- Atomic write ------------------------------------------------------
  try {
    const purchaseId = await prisma.$transaction(async (tx) => {
      // Step 1 — header. Build the data shape conditionally so an
      // omitted `invoiceNo` is persisted as the schema default
      // (NULL) rather than as a literal `undefined` that Prisma
      // might reject under exactOptionalPropertyTypes.
      const headerData: Prisma.PurchaseCreateInput = {
        supplier: { connect: { id: supplierId } },
        total,
        ...(invoiceNo !== null ? { invoiceNo } : {}),
      };
      const purchase = await tx.purchase.create({ data: headerData });

      // Step 2 — items. One INSERT per line carrying the
      // pre-computed `lineTotal` (Req 5.3). We do not use
      // `createMany` because SQLite + Prisma's `createMany` does not
      // return generated ids, and the journal payload below benefits
      // from per-line correlation if a future change adds it.
      for (const line of validatedItems) {
        await tx.purchaseItem.create({
          data: {
            purchaseId: purchase.id,
            productId: line.productId,
            quantity: line.quantity,
            unitBuyPrice: line.unitBuyPrice,
            lineTotal: line.lineTotal,
          },
        });
      }

      // Step 3 — ledger movements. One positive-delta movement per
      // line. `applyMovement` updates `Inventory.onHand` AND inserts
      // the matching `InventoryMovement` row in lock-step, which is
      // what enforces Req 5.4 + the ledger invariant. Throwing here
      // (e.g. P2025 if a product's inventory row is missing) takes
      // every preceding write down with it via Prisma's transaction
      // rollback.
      for (const line of validatedItems) {
        await applyMovement(tx, {
          productId: line.productId,
          delta: line.quantity,
          movementType: 'purchase',
          referenceType: 'purchase',
          referenceId: purchase.id,
          userId: ctx.userId,
        });
      }

      // Step 4 — journal. One row per committed purchase, carrying a
      // replay-friendly JSON payload. The shape mirrors the
      // adjustment payload in inventory.service.adjust so the future
      // replay routine can switch on `opType` and read uniform
      // fields. `total` and per-line decimals are stringified so the
      // payload survives JSON round-tripping without precision loss.
      await tx.journalEntry.create({
        data: {
          opType: 'purchase',
          payload: JSON.stringify({
            purchaseId: purchase.id,
            supplierId,
            invoiceNo,
            total: total.toString(),
            items: validatedItems.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitBuyPrice: line.unitBuyPrice.toString(),
              lineTotal: line.lineTotal.toString(),
            })),
            userId: ctx.userId,
            timestamp: new Date().toISOString(),
          }),
        },
      });

      return purchase.id;
    });

    return Ok({ purchaseId });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // Both error codes mean "the supplierId or a productId is
      // unknown" from this service's perspective:
      //   - P2003 — SQLite-level FK violation on the supplier or
      //     product FK as Prisma tries to insert the header / item.
      //   - P2025 — `applyMovement` called `findUniqueOrThrow`
      //     against `Inventory(productId)`; SQLite raised
      //     "record not found" because the product (and therefore
      //     its inventory row) does not exist.
      // Both surface as a single envelope so the renderer can render
      // "supplier or product not found" without branching on the
      // underlying cause.
      if (err.code === PRISMA_FK_VIOLATION || err.code === PRISMA_RECORD_NOT_FOUND) {
        return Err('FK_VIOLATION', { reason: 'not_found' });
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PurchaseService.list — cursor-paginated listing
// ---------------------------------------------------------------------------

/**
 * Cursor-paginated purchase list (`purchases:list`).
 *
 * Behaviour:
 *   1. Filter (`supplierId`, `dateFrom`/`dateTo`) is compiled to a
 *      Prisma where shape via `compilePurchaseWhere`.
 *   2. Pagination goes through the shared `paginateCursor` helper —
 *      page-size clamping, malformed-cursor → `Err('VALIDATION')`,
 *      `nextCursor` semantics, and `withCount` opt-in all match the
 *      cross-channel contract (Req 16.1–16.3).
 *   3. The cursor sort column is `createdAt`; ordering is the channel
 *      default `(createdAt DESC, id DESC)` so the composite index on
 *      `(supplierId, createdAt)` and the secondary cursor index hit
 *      (Req 16.4 — purchases use the `(supplierId, createdAt)` index
 *      when the supplier filter is set).
 *   4. Each row is mapped to `PurchaseSummaryDTO` with joined
 *      `supplierName` (from `Supplier.name`) and `itemCount` (from
 *      `_count.items`) so renderer rendering does not need an N+1
 *      follow-up.
 *
 * Search is intentionally not part of the channel contract — the
 * Admin-facing browser exposes filters only (supplier, date range).
 * The companion `count` mirrors the same filter shape so paginated
 * totals stay consistent.
 *
 * Validates: Requirements 5.1, 16.1, 16.2, 16.3, 16.4.
 */
async function list(
  req: ListRequest<PurchasesFilter, PurchasesSortKey>,
): Promise<Result<ListResponse<PurchaseSummaryDTO>>> {
  const where = compilePurchaseWhere(req.filter);
  const direction: 'desc' | 'asc' = req.sort?.dir ?? 'desc';

  const paginateOpts = {
    model: makePaginatedPurchaseModel(),
    sortColumn: 'createdAt',
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

  const dtoRows = result.value.rows.map(toPurchaseSummaryDTO);
  const response: ListResponse<PurchaseSummaryDTO> =
    result.value.totalCount !== undefined
      ? { rows: dtoRows, nextCursor: result.value.nextCursor, totalCount: result.value.totalCount }
      : { rows: dtoRows, nextCursor: result.value.nextCursor };
  return Ok(response);
}

/**
 * Companion total-count for `purchases:list`. Wired to
 * `purchases:count`. The wire request shape is `{ filter?, search? }`
 * for parity with every other count channel — `search` is currently
 * unused on this channel (the list does not accept a search term
 * either) but keeping the parameter in the signature lets a future
 * text-search filter slot in without changing the IPC contract.
 *
 * Validates: Requirements 16.1, 16.2.
 */
async function count(
  req: { filter?: PurchasesFilter; search?: string },
): Promise<Result<{ totalCount: number }>> {
  const where = compilePurchaseWhere(req.filter) as Prisma.PurchaseWhereInput;
  const totalCount = await prisma.purchase.count({ where });
  return Ok({ totalCount });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Purchase service surface. Exposed as a frozen object literal so
 * callers import a single named symbol and the IPC handler module
 * wires each method to its channel without instantiating a class.
 * Matches the convention established by every other service in this
 * folder.
 */
export const PurchaseService = Object.freeze({
  create,
  list,
  count,
} as const);
