// src/main/services/customer.service.ts
//
// Customer domain service — list, create-or-update, and per-customer
// sale history (Phase 9, task 9.1).
//
// Responsibilities:
//   - `list(req)`         → cursor-paginated customer directory
//                           ordered by `(name ASC, id ASC)` by default
//                           (Req 7.1, 16.1, 16.3, 16.4). Supports two
//                           sort keys per the IPC contract:
//                           `'name' | 'createdAt'`. Filter shape is
//                           `{ phonePrefix? }`; both `filter.phonePrefix`
//                           and the standalone `search` field apply as
//                           a case-insensitive prefix LIKE against the
//                           indexed `Customer.phone` column (design.md
//                           > "Server-side filter, search, sort").
//
//   - `count(req)`        → companion total-count for the same filter
//                           + search shape (Req 16.1, 16.2).
//
//   - `upsert(input)`     → create-or-update by id. Trim and length-
//                           bound `name` (1..100) and `phone` (0..30).
//                           The Customer model has `@@index([phone])`
//                           but no `@unique` on any column other than
//                           the primary key, so phone duplicates are
//                           allowed and no UNIQUE_VIOLATION mapping is
//                           required. The only Prisma error mapped is
//                           `P2025` (record not found on update) →
//                           `Err('FK_VIOLATION', { reason: 'not_found' })`.
//
//   - `detail({id, ...})` → returns `{ customer, history }` where
//                           the history is a cursor-paginated page of
//                           the customer's own `Sale` rows ordered by
//                           `(createdAt DESC, id)` (Req 7.3). The
//                           history sub-list is driven through the
//                           shared `paginateCursor` helper because
//                           `Sale.createdAt` is time-typed (the
//                           cursor format requires an ISO date for
//                           `ts`); the helper also clamps page size,
//                           decodes / encodes the opaque cursor, and
//                           computes the optional `totalCount`.
//
// Pagination helper (list channel): `Customer` sorts by either `name`
// (string-typed) or `createdAt` (time-typed). The shared
// `paginateCursor` helper (`src/main/db/paginate.ts`) only accepts
// time-typed sort columns — its cursor encoder requires `ts` to parse
// as ISO 8601 — so the list path ships its own small keyset
// paginator that mirrors `supplier.service.ts`'s approach. Same
// opacity guarantees (`base64(JSON({ sv, id }))`), same page-size
// clamp via `clampPageSize`, same "first failing token →
// `Err('VALIDATION', { field: 'cursor' })`" error mapping.
//
// No audit rows are emitted by this service — customer writes are
// not part of the audit-tracked surface in design.md (the audit log
// covers price changes, role changes, stock adjustments, and RBAC
// denials; customer directory edits sit outside that set).
//
// Validates: Requirements 7.1, 7.3, 16.1, 16.3, 16.4.

import { Prisma, type Customer, type Sale } from '@prisma/client';

import {
  paginateCursor,
  type PaginateModel,
  type PaginateWhere,
} from '@main/db/paginate.js';
import { prisma } from '@main/db/prisma.js';
import { clampPageSize } from '@shared/cursor.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type {
  CustomerDTO,
  CustomerFilter,
  CustomerInput,
  CustomerSortKey,
  SaleSummaryDTO,
  SalesSortKey,
} from '@shared/dto/index.js';
import type { ListRequest, ListResponse } from '@shared/ipc-contract.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Application-level bounds on `Customer.name` (trimmed). */
const NAME_MIN = 1;
const NAME_MAX = 100;

/** Application-level bound on `Customer.phone` (trimmed; optional). */
const PHONE_MAX = 30;

/** Search / phonePrefix input is truncated to this many characters
 *  before the prefix LIKE is issued. Same cap as supplier.service. */
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
 * Mirrors the shape used by `supplier.service.ts#validateOptionalString`.
 */
type OptionalStringResult =
  | { kind: 'omit' }
  | { kind: 'set'; value: string | null }
  | 'invalid';

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
// List cursor format (customers-internal)
// ---------------------------------------------------------------------------
//
// The cursor encodes `(sortValue, id)` of the last row of the previous
// page so the next request can resume with `WHERE (sort, id) > (sv, id)`
// (or `<` for descending). When the sort column is `name` the
// shared `encodeCursor` cannot be used because it requires an ISO
// date; when the sort column is `createdAt` we still use this local
// encoder for symmetry — the `Date` is normalized to its ISO string
// inside the cursor payload and converted back to a `Date` instance
// at predicate-build time so SQLite's range predicate matches the
// stored DATETIME column type.

interface CustomerCursorPayload {
  /** Sort column's value at the page tail, normalized to a string.
   *  For 'name' this is the row's name; for 'createdAt' this is the
   *  row's createdAt as an ISO 8601 string. */
  readonly sv: string;
  /** Tie-breaker — always the row id. */
  readonly id: string;
}

function encodeCustomerCursor(payload: CustomerCursorPayload): string {
  return utf8ToBase64(JSON.stringify(payload));
}

function decodeCustomerCursor(token: string): CustomerCursorPayload | null {
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
// equivalents are file-internal. Same approach as supplier.service.
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

type CustomerSortColumn = 'name' | 'createdAt';

function resolveSortColumn(key: CustomerSortKey): CustomerSortColumn {
  // The IPC contract narrows `key` to the supported set; this switch
  // exists so a future addition to `CustomerSortKey` surfaces as a
  // type error here rather than slipping through silently.
  switch (key) {
    case 'name':
      return 'name';
    case 'createdAt':
      return 'createdAt';
  }
}

function readSortValue(row: Customer, sortColumn: CustomerSortColumn): string {
  switch (sortColumn) {
    case 'name':
      return row.name;
    case 'createdAt':
      return row.createdAt.toISOString();
  }
}

/**
 * Build the keyset predicate `(sort, id) ? (cursor.sv, cursor.id)` for
 * the given direction. Expanded into the OR-of-AND form so SQLite's
 * planner can resolve it as an indexed seek + bounded scan against
 * either the `phone` index (when filtered) or a row-id range (otherwise).
 *
 * For `createdAt` the cursor's stringified ISO is converted back to a
 * `Date` instance so Prisma serializes it as the DATETIME comparator
 * SQLite expects; for `name` the string is compared directly.
 */
function buildCursorPredicate(
  sortColumn: CustomerSortColumn,
  direction: 'asc' | 'desc',
  cursor: CustomerCursorPayload,
): Prisma.CustomerWhereInput {
  const op = direction === 'asc' ? 'gt' : 'lt';
  const sortValue: string | Date =
    sortColumn === 'createdAt' ? new Date(cursor.sv) : cursor.sv;
  return {
    OR: [
      { [sortColumn]: { [op]: sortValue } },
      {
        AND: [{ [sortColumn]: sortValue }, { id: { [op]: cursor.id } }],
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
 * - `filter.phonePrefix` → prefix `LIKE` against `Customer.phone`
 *   (Req 16.3, 16.4 — the schema has `@@index([phone])` for this
 *   exact lookup). SQLite's default `LIKE` collation is case-
 *   insensitive for ASCII, so an operator typing "555" matches both
 *   `555-1234` and `555-9999` without renderer normalization.
 * - `search` → identical prefix `LIKE` against `Customer.phone`
 *   (design.md > "Server-side filter, search, sort" lists
 *   `customers.phone` as the primary search column).
 *
 * Both are applied when present so the caller can combine them; in
 * practice the renderer uses one or the other, never both.
 */
function compileWhere(
  filter: CustomerFilter | undefined,
  search: string | undefined,
): Prisma.CustomerWhereInput {
  const clauses: Prisma.CustomerWhereInput[] = [];

  if (filter !== undefined && typeof filter.phonePrefix === 'string') {
    const trimmed = filter.phonePrefix.trim();
    if (trimmed.length > 0) {
      const term = trimmed.slice(0, SEARCH_MAX);
      clauses.push({ phone: { startsWith: term } });
    }
  }

  if (typeof search === 'string') {
    const trimmed = search.trim();
    if (trimmed.length > 0) {
      const term = trimmed.slice(0, SEARCH_MAX);
      clauses.push({ phone: { startsWith: term } });
    }
  }

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0]!;
  return { AND: clauses };
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

function toCustomerDTO(row: Customer): CustomerDTO {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    createdAt: row.createdAt.toISOString(),
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
 * Customer has no UNIQUE constraints on user-editable columns — the
 * schema only carries `@@index([phone])` (non-unique). Two customers
 * may share a phone number, so P2002 is not part of the upsert
 * surface. The only Prisma error we map here is P2025 (record-not-
 * found on update), which surfaces as `FK_VIOLATION` with
 * `reason: 'not_found'` for parity with `supplier.service.ts`.
 */
function mapPrismaError(
  err: Prisma.PrismaClientKnownRequestError,
): ReturnType<typeof Err> | null {
  if (err.code === PRISMA_RECORD_NOT_FOUND) {
    return Err('FK_VIOLATION', { reason: 'not_found' });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sale history (detail sub-list)
// ---------------------------------------------------------------------------

/** Sale row shape returned by `sale.findMany` once the `customer` +
 *  `cashier` joins are attached. Mirrors the supplier-side
 *  `PurchaseRowWithRelations` pattern. */
type SaleRowWithRelations = Sale & {
  customer: { name: string } | null;
  cashier: { username: string };
};

/**
 * Wrap `prisma.sale` so it satisfies the structural
 * `PaginateModel<SaleRowWithRelations>` contract while transparently
 * attaching the `customer` + `cashier` joins on every `findMany`
 * call. Mirrors the supplier-history wrapper.
 *
 * The history sub-list is always scoped to one customer — the wrapper
 * composes the cursor predicate (which `paginateCursor` passes as
 * `args.where`) with the `customerId = customerId` anchor via a
 * top-level AND so any composite predicate stays well-formed.
 */
function makePaginatedSaleModel(
  customerId: string,
): PaginateModel<SaleRowWithRelations> {
  const include = {
    customer: { select: { name: true } },
    cashier: { select: { username: true } },
  } as const satisfies Prisma.SaleInclude;

  const model: PaginateModel<SaleRowWithRelations> = {
    async findMany(args) {
      const composedWhere: Prisma.SaleWhereInput =
        args.where !== undefined
          ? { AND: [{ customerId }, args.where] }
          : { customerId };

      const findArgs: Prisma.SaleFindManyArgs = {
        orderBy: args.orderBy as unknown as Prisma.SaleOrderByWithRelationInput[],
        take: args.take,
        include,
        where: composedWhere,
      };
      const rows = await prisma.sale.findMany(findArgs);
      return rows as SaleRowWithRelations[];
    },
    count(args) {
      const composedWhere: Prisma.SaleWhereInput =
        args.where !== undefined
          ? { AND: [{ customerId }, args.where] }
          : { customerId };
      return prisma.sale.count({ where: composedWhere });
    },
  };
  return model;
}

/**
 * Project a joined `Sale` row onto the cross-process `SaleSummaryDTO`.
 *
 * `grandTotal` is stringified (the DTO contract keeps decimals as
 * strings end-to-end so the wire format is round-trip-safe with
 * `Prisma.Decimal`); `createdAt` is normalized to ISO 8601 so the
 * renderer never has to handle a `Date` instance crossing the IPC
 * boundary; `customerName` is read off the `customer` join (always
 * present here because the history sub-list is scoped to a known
 * customerId, but the schema allows null so the projection guards
 * for completeness).
 */
function toSaleSummaryDTO(row: SaleRowWithRelations): SaleSummaryDTO {
  return {
    id: row.id,
    serialNo: row.serialNo,
    grandTotal: row.grandTotal.toString(),
    customerName: row.customer?.name ?? null,
    cashierName: row.cashier.username,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CustomerService
// ---------------------------------------------------------------------------

/**
 * Cursor-paginated customer list (`customers:list`).
 *
 * Defaults:
 *   - sort key: `'name'`,
 *   - direction: `'asc'` (alphabetical directory; matches the task
 *     description "sort name ASC, id ASC"),
 *   - page size: 50, clamped server-side to [1, 200].
 *
 * Filter:
 *   - `filter.phonePrefix` — prefix LIKE against `phone`.
 *   - `search` — same prefix LIKE against `phone`. Both are applied
 *     when present (logical AND).
 *
 * Cursor:
 *   - Opaque base64 JSON of `{ sv, id }`. Malformed tokens surface
 *     as `Err('VALIDATION', { field: 'cursor' })` (Req 16.3).
 *
 * Validates: Requirements 7.1, 16.1, 16.3, 16.4.
 */
async function list(
  req: ListRequest<CustomerFilter, CustomerSortKey>,
): Promise<Result<ListResponse<CustomerDTO>>> {
  const take = clampPageSize(req.pageSize);
  const sortKey: CustomerSortKey = req.sort?.key ?? 'name';
  // Default direction is ascending so the alphabetical default
  // matches the task description ("sort name ASC, id ASC").
  const direction: 'asc' | 'desc' = req.sort?.dir ?? 'asc';
  const sortColumn = resolveSortColumn(sortKey);

  let cursorPredicate: Prisma.CustomerWhereInput | undefined;
  if (req.cursor !== undefined) {
    const decoded = decodeCustomerCursor(req.cursor);
    if (decoded === null) {
      return Err('VALIDATION', { field: 'cursor' });
    }
    cursorPredicate = buildCursorPredicate(sortColumn, direction, decoded);
  }

  const baseWhere = compileWhere(req.filter, req.search);
  const where: Prisma.CustomerWhereInput =
    cursorPredicate !== undefined
      ? Object.keys(baseWhere).length === 0
        ? cursorPredicate
        : { AND: [baseWhere, cursorPredicate] }
      : baseWhere;

  // Two-key ordering keeps pagination deterministic across rows that
  // share the same sort-column value (e.g. customers without a
  // surname who all sort to the same `name` slot).
  const orderBy: Prisma.CustomerOrderByWithRelationInput[] = [
    { [sortColumn]: direction },
    { id: direction },
  ];

  const findManyArgs: Prisma.CustomerFindManyArgs = {
    where,
    orderBy,
    take,
  };

  const [rows, totalCount] = await Promise.all([
    prisma.customer.findMany(findManyArgs),
    req.withCount === true
      ? prisma.customer.count({ where: baseWhere })
      : Promise.resolve(undefined),
  ]);

  let nextCursor: string | null = null;
  if (rows.length === take && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    nextCursor = encodeCustomerCursor({
      sv: readSortValue(last, sortColumn),
      id: last.id,
    });
  }

  const dtos = rows.map(toCustomerDTO);
  const response: ListResponse<CustomerDTO> =
    totalCount !== undefined
      ? { rows: dtos, nextCursor, totalCount }
      : { rows: dtos, nextCursor };
  return Ok(response);
}

/**
 * Companion total-count for `customers:list`. Wired to
 * `customers:count`; cursor and pageSize are intentionally not part
 * of this request shape because they would not affect the count.
 */
async function count(
  req: { filter?: CustomerFilter; search?: string },
): Promise<Result<{ totalCount: number }>> {
  const where = compileWhere(req.filter, req.search);
  const totalCount = await prisma.customer.count({ where });
  return Ok({ totalCount });
}

/**
 * Create or update a customer by id.
 *
 * Validation order: name → phone. The first failing field returns
 * `Err('VALIDATION', { field })` so the renderer can mark the single
 * offending input.
 *
 * On create: a single `prisma.customer.create`; the schema has no
 * dependent rows to seed alongside it.
 *
 * On update: only the fields the renderer included are written. The
 * three-state pattern for `phone` mirrors `supplier.service.ts`:
 *   - omitted    → leave alone.
 *   - `null`     → explicit clear.
 *   - non-empty  → trim + bound + set.
 *   - empty/whitespace → treated as clear (mirrors renderer behaviour
 *     when the user empties an input).
 *
 * Validates: Requirements 7.1, 7.2, 7.4.
 */
async function upsert(input: CustomerInput): Promise<Result<CustomerDTO>> {
  const name = validateRequiredString(input.name, NAME_MIN, NAME_MAX);
  if (name === null) return Err('VALIDATION', { field: 'name' });

  const phone = validateOptionalString(input.phone, PHONE_MAX);
  if (phone === 'invalid') return Err('VALIDATION', { field: 'phone' });

  try {
    if (input.id === undefined) {
      // Create path. Default optional fields to null when the
      // caller omitted them — `phone.kind === 'omit'` on create
      // means "no phone supplied", which we persist as null.
      const created = await prisma.customer.create({
        data: {
          name,
          phone: phone.kind === 'set' ? phone.value : null,
        },
      });
      return Ok(toCustomerDTO(created));
    }

    // Update path. Build the `data` shape conditionally so a renderer
    // that omitted `phone` does not accidentally clear it.
    const data: Prisma.CustomerUpdateInput = {
      name,
      ...(phone.kind === 'set' ? { phone: phone.value } : {}),
    };

    const updated = await prisma.customer.update({
      where: { id: input.id },
      data,
    });
    return Ok(toCustomerDTO(updated));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapPrismaError(err);
      if (mapped !== null) return mapped;
    }
    throw err;
  }
}

/**
 * Customer detail with paginated sale history.
 *
 * Returns `{ customer, history }` where `history` is the next page of
 * `Sale` rows for the customer ordered by `(createdAt DESC, id)`
 * (Req 7.3). The history sub-list is cursor-paginated through the
 * shared `paginateCursor` helper because `createdAt` is time-typed.
 *
 * When the customer id is unknown, returns `Err('FK_VIOLATION',
 * { reason: 'not_found' })` so the renderer can render a "customer
 * not found" surface rather than an INTERNAL toast.
 *
 * Validates: Requirements 7.3, 16.1, 16.3, 16.4.
 */
async function detail(req: {
  id: string;
  history?: ListRequest<Record<string, never>, SalesSortKey>;
}): Promise<
  Result<{ customer: CustomerDTO; history: ListResponse<SaleSummaryDTO> }>
> {
  if (typeof req.id !== 'string' || req.id.length === 0) {
    return Err('VALIDATION', { field: 'id' });
  }

  const customer = await prisma.customer.findUnique({ where: { id: req.id } });
  if (customer === null) {
    return Err('FK_VIOLATION', { reason: 'not_found' });
  }

  const historyReq = req.history ?? {};
  const direction: 'asc' | 'desc' = historyReq.sort?.dir ?? 'desc';

  const paginateOpts = {
    model: makePaginatedSaleModel(customer.id),
    sortColumn: 'createdAt',
    direction,
    // No additional filter needed — the wrapper already scopes every
    // findMany / count to the target customerId. Pass cursor /
    // pageSize / withCount through verbatim.
    ...(historyReq.cursor !== undefined ? { cursor: historyReq.cursor } : {}),
    ...(historyReq.pageSize !== undefined ? { pageSize: historyReq.pageSize } : {}),
    ...(historyReq.withCount === true ? { withCount: true as const } : {}),
  };

  const result = await paginateCursor(paginateOpts);
  if (!result.ok) {
    return result;
  }

  const dtoRows = result.value.rows.map(toSaleSummaryDTO);
  const history: ListResponse<SaleSummaryDTO> =
    result.value.totalCount !== undefined
      ? {
          rows: dtoRows,
          nextCursor: result.value.nextCursor,
          totalCount: result.value.totalCount,
        }
      : { rows: dtoRows, nextCursor: result.value.nextCursor };

  return Ok({ customer: toCustomerDTO(customer), history });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Customer service surface. Exposed as a frozen object literal so
 * callers import a single named symbol and the IPC handler module
 * wires each method to its channel without instantiating a class.
 * Matches the convention established by every other service in this
 * folder.
 */
export const CustomerService = Object.freeze({
  list,
  count,
  upsert,
  detail,
} as const);

// `PaginateWhere` is re-exported to keep imports tidy for tests
// that exercise the helper directly. Not part of the wire surface.
export type { PaginateWhere };
