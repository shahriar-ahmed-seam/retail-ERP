// src/main/services/supplier.service.ts
//
// Supplier domain service — list, lookup, create-or-update, and per-
// supplier purchase history (Phase 6, task 6.1).
//
// Responsibilities:
//   - `list(req)`         → cursor-paginated supplier directory ordered
//                           by `(name ASC, id ASC)` (Req 6.2). Supports
//                           server-side prefix `search` against `name`.
//   - `count(req)`        → companion total-count for the list channel's
//                           filter + search shape (Req 16.1, 16.2).
//   - `upsert(input)`     → create-or-update by id. Trim and length-
//                           bound `name` (1..100), `phone` (0..30) and
//                           `address` (0..200). The Supplier model has
//                           `@@index([name])` but no `@unique` on any
//                           text column, so no UNIQUE_VIOLATION mapping
//                           is required; the only Prisma errors that
//                           can surface here are P2025 (record not
//                           found on update) and P2003 (FK violation —
//                           which Supplier itself does not produce
//                           because it has no outbound FKs).
//   - `detail({id, ...})` → returns `{ supplier, history }` where the
//                           history is a cursor-paginated page of the
//                           supplier's own `Purchase` rows ordered by
//                           `(createdAt DESC, id)`. The shared
//                           `paginateCursor` helper drives the history
//                           sub-list because `Purchase.createdAt` is
//                           time-typed (the cursor format requires an
//                           ISO date for `ts`).
//
// Pagination helper (list channel): `Supplier` sorts by `name`, which
// is string-typed and therefore not compatible with the shared
// `paginateCursor` helper (whose cursor encoder requires the `ts`
// field to parse as an ISO date). This module ships its own small
// keyset paginator that mirrors `product.service.ts`'s approach —
// same opacity guarantees (`base64(JSON({ sv, id }))`), same
// page-size clamp via `clampPageSize`, same "first failing token →
// `Err('VALIDATION', { field: 'cursor' })`" error mapping. The
// detail-history sub-list, by contrast, IS time-typed (`createdAt`)
// and uses the shared helper directly.
//
// No audit rows are emitted by this service — supplier writes are
// not part of the audit-tracked surface in design.md (the audit log
// covers price changes, role changes, stock adjustments, and RBAC
// denials; supplier directory edits sit outside that set).
//
// Validates: Requirements 6.1, 6.2, 6.3, 16.1, 16.2, 16.3, 16.5.

import { Prisma, type Purchase, type Supplier } from '@prisma/client';

import {
  paginateCursor,
  type PaginateModel,
  type PaginateWhere,
} from '@main/db/paginate.js';
import { prisma } from '@main/db/prisma.js';
import { clampPageSize } from '@shared/cursor.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type {
  PurchaseSummaryDTO,
  PurchasesSortKey,
  SupplierDTO,
  SupplierFilter,
  SupplierInput,
  SupplierSortKey,
} from '@shared/dto/index.js';
import type { ListRequest, ListResponse } from '@shared/ipc-contract.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Application-level bounds on `Supplier.name` (trimmed). */
const NAME_MIN = 1;
const NAME_MAX = 100;

/** Application-level bound on `Supplier.phone` (trimmed; optional). */
const PHONE_MAX = 30;

/** Application-level bound on `Supplier.address` (trimmed; optional). */
const ADDRESS_MAX = 200;

/** Search input is truncated to this many characters before issuing the prefix LIKE. */
const SEARCH_MAX = 100;

/** Prisma's known-error codes we map to envelope codes. */
const PRISMA_RECORD_NOT_FOUND = 'P2025';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Trim + length-check a required string field. Returns the trimmed value or `null`. */
function validateRequiredString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Validate an optional, three-state string field. Distinguishes:
 *
 *   - `undefined` → caller did not supply the field; leave alone on
 *                   update, default null on create.
 *   - `null`      → explicit clear.
 *   - `string`    → trim; whitespace-only collapses to `null` (so
 *                   empty inputs from the renderer behave like a
 *                   clear); over-bound returns `'invalid'`.
 *
 * Returns one of the three normalized states, or the literal
 * `'invalid'` when the input shape itself is wrong.
 */
type OptionalStringResult = { kind: 'omit' } | { kind: 'set'; value: string | null } | 'invalid';

function validateOptionalString(value: unknown, max: number): OptionalStringResult {
  if (value === undefined) return { kind: 'omit' };
  if (value === null) return { kind: 'set', value: null };
  if (typeof value !== 'string') return 'invalid';
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: 'set', value: null };
  if (trimmed.length > max) return 'invalid';
  return { kind: 'set', value: trimmed };
}

// ---------------------------------------------------------------------------
// List cursor format (suppliers-internal)
// ---------------------------------------------------------------------------
//
// The cursor encodes `(sortValue, id)` of the last row of the previous
// page so the next request can resume with `WHERE (sort, id) > (sv, id)`
// (or `<` for descending). `Supplier` has only string-typed sort
// columns (`name`), so the shared `encodeCursor` (which requires ISO
// dates) cannot be used here; instead we use a lightweight base64(JSON)
// encoding with the same opacity guarantees as the renderer's
// generic data hook expects.

interface SupplierCursorPayload {
  /** The sort column's value at the page tail. */
  readonly sv: string;
  /** Tie-breaker — always the row id. */
  readonly id: string;
}

function encodeSupplierCursor(payload: SupplierCursorPayload): string {
  return utf8ToBase64(JSON.stringify(payload));
}

function decodeSupplierCursor(token: string): SupplierCursorPayload | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  let json: string;
  try {
    json = base64ToUtf8(token);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const { sv, id } = raw as { sv?: unknown; id?: unknown };
  if (typeof sv !== 'string' || sv.length === 0) return null;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { sv, id };
}

// Cross-environment UTF-8 ↔ base64 helpers — duplicated locally rather
// than imported from `@shared/cursor.js` because that module's
// equivalents are file-internal. Tiny enough that the duplication is
// not worth widening the cursor module's public surface.
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(b: string): string {
  const binary = atob(b);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// ---------------------------------------------------------------------------
// Sort + cursor predicate compilation
// ---------------------------------------------------------------------------

/**
 * Map an `IpcContract` sort key to the actual Prisma column. The
 * supplier list channel only declares `'name'` today; future sort
 * keys (e.g. `'createdAt'`) would resolve through this same dispatch.
 */
function resolveSortColumn(_key: SupplierSortKey): 'name' {
  return 'name';
}

function readSortValue(row: Supplier, sortColumn: 'name'): string {
  switch (sortColumn) {
    case 'name':
      return row.name;
  }
}

/**
 * Build the keyset predicate `(sort, id) > (cursor.sv, cursor.id)` for
 * the given direction. Expanded into the OR-of-AND form so SQLite's
 * planner can resolve it as an indexed seek + bounded scan against
 * the `name` index.
 */
function buildCursorPredicate(
  sortColumn: 'name',
  direction: 'asc' | 'desc',
  cursor: SupplierCursorPayload,
): Prisma.SupplierWhereInput {
  const op = direction === 'asc' ? 'gt' : 'lt';
  return {
    OR: [
      { [sortColumn]: { [op]: cursor.sv } },
      {
        AND: [{ [sortColumn]: cursor.sv }, { id: { [op]: cursor.id } }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Filter compilation
// ---------------------------------------------------------------------------

/**
 * Compile the renderer-supplied `filter` + `search` shape into a
 * Prisma `WhereInput`.
 *
 * - `filter` carries no fields today (`SupplierFilter` is a reserved
 *   placeholder for future status/region filters); included for
 *   parity with every other list channel.
 * - `search` (trimmed, length-clamped) → prefix `LIKE` against `name`.
 *   SQLite's default `LIKE` collation is case-insensitive for ASCII
 *   so an admin searching "acme" matches both `Acme` and `acme` rows
 *   without renderer normalization.
 */
function compileWhere(
  _filter: SupplierFilter | undefined,
  search: string | undefined,
): Prisma.SupplierWhereInput {
  const clauses: Prisma.SupplierWhereInput[] = [];

  if (typeof search === 'string') {
    const trimmed = search.trim();
    if (trimmed.length > 0) {
      const term = trimmed.slice(0, SEARCH_MAX);
      clauses.push({ name: { startsWith: term } });
    }
  }

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0]!;
  return { AND: clauses };
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

function toSupplierDTO(row: Supplier): SupplierDTO {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    address: row.address ?? null,
  };
}


// ---------------------------------------------------------------------------
// Prisma error mapping
// ---------------------------------------------------------------------------

/**
 * Map a `PrismaClientKnownRequestError` raised on `upsert` to a wire
 * envelope. Returns `null` for errors we don't recognize so the caller
 * can rethrow.
 *
 * Supplier has no UNIQUE constraints on user-editable text columns —
 * the schema only carries `@@index([name])` (non-unique). Two
 * suppliers may share a name, so P2002 is not part of the upsert
 * surface. The only Prisma error we map here is P2025 (record-not-
 * found on update), which surfaces as `FK_VIOLATION` with
 * `reason: 'not_found'` for parity with `product.service.ts`.
 */
function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): ReturnType<typeof Err> | null {
  if (err.code === PRISMA_RECORD_NOT_FOUND) {
    return Err('FK_VIOLATION', { reason: 'not_found' });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Purchase history (detail sub-list)
// ---------------------------------------------------------------------------

/** Purchase row shape returned by `purchase.findMany` once the
 *  `Supplier` join + `_count` of items are attached. */
type PurchaseRowWithRelations = Purchase & {
  supplier: { name: string };
  _count: { items: number };
};

/**
 * Wrap `prisma.purchase` so it satisfies the structural
 * `PaginateModel<PurchaseRowWithRelations>` contract while transparently
 * attaching the `Supplier` + items-count joins on every `findMany`
 * call. Mirrors the inventory-service movement wrapper.
 */
function makePaginatedPurchaseModel(
  supplierId: string,
): PaginateModel<PurchaseRowWithRelations> {
  const include = {
    supplier: { select: { name: true } },
    _count: { select: { items: true } },
  } as const satisfies Prisma.PurchaseInclude;

  const model: PaginateModel<PurchaseRowWithRelations> = {
    async findMany(args) {
      // The history sub-list is always scoped to one supplier — the
      // helper composes the cursor predicate with this anchor where
      // via top-level AND, so we pass it through `args.where` if the
      // helper already attached one.
      const composedWhere: Prisma.PurchaseWhereInput =
        args.where !== undefined
          ? { AND: [{ supplierId }, args.where] }
          : { supplierId };

      const findArgs: Prisma.PurchaseFindManyArgs = {
        orderBy: args.orderBy as unknown as Prisma.PurchaseOrderByWithRelationInput[],
        take: args.take,
        include,
        where: composedWhere,
      };
      const rows = await prisma.purchase.findMany(findArgs);
      return rows as PurchaseRowWithRelations[];
    },
    count(args) {
      const composedWhere: Prisma.PurchaseWhereInput =
        args.where !== undefined
          ? { AND: [{ supplierId }, args.where] }
          : { supplierId };
      return prisma.purchase.count({ where: composedWhere });
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
// SupplierService
// ---------------------------------------------------------------------------

/**
 * Cursor-paginated supplier list (`suppliers:list`). Sort defaults to
 * `(name ASC, id ASC)` per Req 6.2 — alphabetical directory.
 */
async function list(
  req: ListRequest<SupplierFilter, SupplierSortKey>,
): Promise<Result<ListResponse<SupplierDTO>>> {
  const take = clampPageSize(req.pageSize);
  const sortKey: SupplierSortKey = req.sort?.key ?? 'name';
  // Default direction is ascending so the alphabetical default
  // matches the requirements ("ordered by name", Req 6.2).
  const direction: 'asc' | 'desc' = req.sort?.dir ?? 'asc';
  const sortColumn = resolveSortColumn(sortKey);

  let cursorPredicate: Prisma.SupplierWhereInput | undefined;
  if (req.cursor !== undefined) {
    const decoded = decodeSupplierCursor(req.cursor);
    if (decoded === null) {
      return Err('VALIDATION', { field: 'cursor' });
    }
    cursorPredicate = buildCursorPredicate(sortColumn, direction, decoded);
  }

  const baseWhere = compileWhere(req.filter, req.search);
  const where: Prisma.SupplierWhereInput =
    cursorPredicate !== undefined
      ? Object.keys(baseWhere).length === 0
        ? cursorPredicate
        : { AND: [baseWhere, cursorPredicate] }
      : baseWhere;

  // Two-key ordering keeps pagination deterministic across rows that
  // share the same sort-column value (e.g. suppliers with the same
  // name).
  const orderBy: Prisma.SupplierOrderByWithRelationInput[] = [
    { [sortColumn]: direction },
    { id: direction },
  ];

  const findManyArgs: Prisma.SupplierFindManyArgs = {
    where,
    orderBy,
    take,
  };

  const [rows, totalCount] = await Promise.all([
    prisma.supplier.findMany(findManyArgs),
    req.withCount === true ? prisma.supplier.count({ where: baseWhere }) : Promise.resolve(undefined),
  ]);

  let nextCursor: string | null = null;
  if (rows.length === take && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    nextCursor = encodeSupplierCursor({ sv: readSortValue(last, sortColumn), id: last.id });
  }

  const dtos = rows.map(toSupplierDTO);
  const response: ListResponse<SupplierDTO> =
    totalCount !== undefined
      ? { rows: dtos, nextCursor, totalCount }
      : { rows: dtos, nextCursor };
  return Ok(response);
}

/**
 * Companion total-count for `suppliers:list`. Wired to
 * `suppliers:count`; cursor and pageSize are intentionally not part
 * of this request shape because they would not affect the count.
 */
async function count(
  req: { filter?: SupplierFilter; search?: string },
): Promise<Result<{ totalCount: number }>> {
  const where = compileWhere(req.filter, req.search);
  const totalCount = await prisma.supplier.count({ where });
  return Ok({ totalCount });
}

/**
 * Create or update a supplier by id.
 *
 * Validation order: name → phone → address. The first failing field
 * returns `Err('VALIDATION', { field })` so the renderer can mark
 * the single offending input.
 *
 * On create: a single `prisma.supplier.create`; the schema has no
 * dependent rows (Inventory-style) to seed alongside it.
 *
 * On update: only the fields the renderer included are written. The
 * three-state pattern for `phone`/`address` is the same as
 * `product.service.ts#upsert#barcode`:
 *   - omitted    → leave alone.
 *   - `null`     → explicit clear.
 *   - non-empty  → trim + bound + set.
 *   - empty/whitespace → treated as clear (mirrors renderer behaviour
 *     when the user empties an input).
 */
async function upsert(input: SupplierInput): Promise<Result<SupplierDTO>> {
  const name = validateRequiredString(input.name, NAME_MIN, NAME_MAX);
  if (name === null) return Err('VALIDATION', { field: 'name' });

  const phone = validateOptionalString(input.phone, PHONE_MAX);
  if (phone === 'invalid') return Err('VALIDATION', { field: 'phone' });

  const address = validateOptionalString(input.address, ADDRESS_MAX);
  if (address === 'invalid') return Err('VALIDATION', { field: 'address' });

  try {
    if (input.id === undefined) {
      // Create path. Default optional fields to null when the
      // caller omitted them — `phone.kind === 'omit'` on create
      // means "no phone supplied", which we persist as null.
      const created = await prisma.supplier.create({
        data: {
          name,
          phone: phone.kind === 'set' ? phone.value : null,
          address: address.kind === 'set' ? address.value : null,
        },
      });
      return Ok(toSupplierDTO(created));
    }

    // Update path. Build the `data` shape conditionally so a renderer
    // that omitted `phone` or `address` does not accidentally clear
    // them.
    const data: Prisma.SupplierUpdateInput = {
      name,
      ...(phone.kind === 'set' ? { phone: phone.value } : {}),
      ...(address.kind === 'set' ? { address: address.value } : {}),
    };

    const updated = await prisma.supplier.update({
      where: { id: input.id },
      data,
    });
    return Ok(toSupplierDTO(updated));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapPrismaError(err);
      if (mapped !== null) return mapped;
    }
    throw err;
  }
}

/**
 * Supplier detail with paginated purchase history.
 *
 * Returns `{ supplier, history }` where `history` is the next page of
 * `Purchase` rows for the supplier ordered by
 * `(createdAt DESC, id)` (Req 6.3 — purchase history descending).
 * The history sub-list is cursor-paginated through the shared
 * `paginateCursor` helper because `createdAt` is time-typed.
 *
 * When the supplier id is unknown, returns `Err('FK_VIOLATION',
 * { reason: 'not_found' })` so the renderer can render a "supplier
 * not found" surface rather than an INTERNAL toast.
 */
async function detail(req: {
  id: string;
  history?: ListRequest<Record<string, never>, PurchasesSortKey>;
}): Promise<
  Result<{ supplier: SupplierDTO; history: ListResponse<PurchaseSummaryDTO> }>
> {
  if (typeof req.id !== 'string' || req.id.length === 0) {
    return Err('VALIDATION', { field: 'id' });
  }

  const supplier = await prisma.supplier.findUnique({ where: { id: req.id } });
  if (supplier === null) {
    return Err('FK_VIOLATION', { reason: 'not_found' });
  }

  const historyReq = req.history ?? {};
  const direction: 'asc' | 'desc' = historyReq.sort?.dir ?? 'desc';

  const paginateOpts = {
    model: makePaginatedPurchaseModel(supplier.id),
    sortColumn: 'createdAt',
    direction,
    // No additional filter needed — the wrapper already scopes every
    // findMany / count to the target supplierId. Pass cursor /
    // pageSize / withCount through verbatim.
    ...(historyReq.cursor !== undefined ? { cursor: historyReq.cursor } : {}),
    ...(historyReq.pageSize !== undefined ? { pageSize: historyReq.pageSize } : {}),
    ...(historyReq.withCount === true ? { withCount: true as const } : {}),
  };

  const result = await paginateCursor(paginateOpts);
  if (!result.ok) {
    return result;
  }

  const dtoRows = result.value.rows.map(toPurchaseSummaryDTO);
  const history: ListResponse<PurchaseSummaryDTO> =
    result.value.totalCount !== undefined
      ? {
          rows: dtoRows,
          nextCursor: result.value.nextCursor,
          totalCount: result.value.totalCount,
        }
      : { rows: dtoRows, nextCursor: result.value.nextCursor };

  return Ok({ supplier: toSupplierDTO(supplier), history });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Supplier service surface. Exposed as a frozen object literal so
 * callers import a single named symbol and the IPC handler module
 * wires each method to its channel without instantiating a class.
 * Matches the convention established by every other service in this
 * folder.
 */
export const SupplierService = Object.freeze({
  list,
  count,
  upsert,
  detail,
} as const);

// `PaginateWhere` is a re-export to keep the import tidy for tests
// that exercise the helper directly. Not part of the wire surface.
export type { PaginateWhere };
