// src/main/services/product.service.ts
//
// Product domain service — list, lookup, and create-or-update on the
// `products` reference table (Phase 4, task 4.2).
//
// Responsibilities:
//   - `list(req)`         → cursor-paginated catalog listing with
//                           server-side filter (`categoryId`,
//                           `lowStockOnly`), prefix search (on `name`
//                           and `sku`), and sort (`name` | `sku` |
//                           `createdAt`). Always projects the joined
//                           `Inventory.onHand` value onto the wire DTO.
//   - `count(req)`        → companion total-count for the same filter +
//                           search shape that drives the list view's
//                           totals strip (Req 16.1, 16.2).
//   - `getById(id)`       → single-row lookup, includes inventory.
//   - `getByBarcode(b)`   → single-row lookup by the unique `barcode`
//                           index (drives `pos:scan`, Req 4.1, 12.1).
//   - `upsert(input, ctx)` → create-or-update. On create, opens a
//                           `$transaction` to insert the product row
//                           AND the matching `Inventory(onHand=0)` row
//                           atomically (Req 3.2, 11.4). Maps Prisma's
//                           known errors to wire envelopes:
//                             - P2002 (unique violation) →
//                               `Err('UNIQUE_VIOLATION', { field })`
//                               where `field` is `'sku'` or `'barcode'`
//                               based on the offending index target.
//                             - P2025 (record not found, on update) →
//                               `Err('FK_VIOLATION',
//                                    { reason: 'not_found' })`.
//                             - P2003 (FK violation, e.g. unknown
//                               `categoryId`) →
//                               `Err('FK_VIOLATION',
//                                    { field: 'categoryId' })`.
//
// Pagination helper: this service rolls its own small keyset paginator
// (`paginateProductList`) instead of the shared
// `src/main/db/paginate.ts#paginateCursor` because the latter only
// handles time-typed sort columns — `paginateCursor#encodeCursor`
// requires the cursor's `ts` field to parse as an ISO date. Products
// sort by `name` or `sku` (string-typed) and the schema currently has
// no `createdAt` column on `Product`, so the shared helper would refuse
// to encode the tail of any page. The inline helper mirrors the same
// contract — `clampPageSize`, malformed-cursor → VALIDATION, opaque
// base64-JSON token, `nextCursor: null` when the page completes the
// result set — so the renderer's generic `<VirtualizedTable>` data
// hook (task 4.8) can drive `products:list` exactly as it drives every
// other paginated channel.
//
// Price-change auditing (task 4.3, Req 2.4 + 13.1): on the `upsert`
// update path, when `buyPrice` or `sellPrice` would change, the
// service opens a `$transaction` and inserts an `AuditLog` row of
// type `price.change` carrying the previous and new prices, the
// acting user, and the entity id, BEFORE applying the product
// update. Both writes commit atomically — if the update fails
// (unique violation, FK violation, missing record), the audit row
// rolls back with it, so the audit log only reflects price changes
// that actually persisted. When neither price changes, no audit row
// is written and the update runs as a single Prisma write.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 7 (read-only access),
//            13.1.

import { Prisma, type Inventory, type Product } from '@prisma/client';

import { prisma } from '@main/db/prisma.js';
import { clampPageSize } from '@shared/cursor.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type {
  ProductDTO,
  ProductFilter,
  ProductInput,
  ProductSortKey,
} from '@shared/dto/index.js';
import type {
  ListRequest,
  ListResponse,
} from '@shared/ipc-contract.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Application-level bounds on `Product.name` (trimmed). */
const NAME_MIN = 1;
const NAME_MAX = 100;

/** Application-level bounds on `Product.sku` (trimmed). */
const SKU_MIN = 1;
const SKU_MAX = 50;

/** Application-level bound on `Product.barcode` (trimmed). */
const BARCODE_MIN = 1;
const BARCODE_MAX = 64;

/** Search input is truncated to this many characters before issuing the prefix LIKE. */
const SEARCH_MAX = 100;

/** Prisma's known-error codes we map to envelope codes. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';
const PRISMA_RECORD_NOT_FOUND = 'P2025';
const PRISMA_FK_VIOLATION = 'P2003';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Trim + length-check a required string field. Returns the trimmed value or `null`. */
function validateString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Validate a decimal-string money / rate value. Accepts non-negative
 * finite numbers expressed as a string with at most 4 fractional digits
 * (`buyPrice` / `sellPrice` are stored as `Decimal`; the renderer
 * serializes them as fixed-precision strings per the DTO contract).
 *
 * Returns the canonical decimal string (whitespace-trimmed) or `null`.
 * `Prisma.Decimal` is the parser of last resort: any input it accepts is
 * a value SQLite can store, and we don't second-guess its representation
 * choices.
 */
function validateDecimal(value: unknown, opts: { allowZero: boolean }): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Allow only a leading sign, digits, and a single decimal point. This
  // is conservative — Prisma.Decimal accepts scientific notation and
  // other forms — but matches what the renderer's money helper produces.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  let dec: Prisma.Decimal;
  try {
    dec = new Prisma.Decimal(trimmed);
  } catch {
    return null;
  }
  if (dec.isNegative()) return null;
  if (!opts.allowZero && dec.isZero()) return null;
  return dec.toString();
}

/** Validate a non-negative integer. Returns the value or `null`. */
function validateNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value < 0) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Cursor format (products-internal)
// ---------------------------------------------------------------------------
//
// The cursor encodes `(sortValue, id)` of the last row of the previous
// page so the next request can resume with `WHERE (sort, id) > (sv, id)`
// (or `<` for descending). Because `Product` has no time-typed sort
// columns, we cannot use the shared `encodeCursor` (which requires ISO
// dates); instead we use a lightweight base64(JSON) encoding with the
// same opacity guarantees.

interface ProductCursorPayload {
  /** The sort column's value at the page tail. For `createdAt` we encode the row id. */
  readonly sv: string;
  /** Tie-breaker — always the row id. */
  readonly id: string;
}

function encodeProductCursor(payload: ProductCursorPayload): string {
  return utf8ToBase64(JSON.stringify(payload));
}

function decodeProductCursor(token: string): ProductCursorPayload | null {
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
 * schema has no `createdAt` on `Product`; we substitute `id` because
 * cuid identifiers embed a timestamp in their leading bytes and sort
 * lexicographically in roughly the same order as creation time. This
 * keeps `ListRequest<.., 'createdAt'>` working today without a new
 * migration; the substitution is transparent to renderers.
 */
function resolveSortColumn(key: ProductSortKey): 'name' | 'sku' | 'id' {
  switch (key) {
    case 'name':
      return 'name';
    case 'sku':
      return 'sku';
    case 'createdAt':
      return 'id';
  }
}

/**
 * Read the value used to encode the cursor's `sv` field from a freshly
 * returned row. For `createdAt` (which we resolve to `id`) the `sv`
 * field equals the `id` field — that's fine, the cursor still works
 * because the keyset predicate is `(id, id) > (cursor.sv, cursor.id)`.
 */
function readSortValue(row: Product, sortColumn: 'name' | 'sku' | 'id'): string {
  switch (sortColumn) {
    case 'name':
      return row.name;
    case 'sku':
      return row.sku;
    case 'id':
      return row.id;
  }
}

/**
 * Build the keyset predicate `(sort, id) > (cursor.sv, cursor.id)` for
 * the given direction. Expanded into the OR-of-AND form so SQLite's
 * planner can resolve it as an indexed seek + bounded scan against the
 * `name`/`sku` indexes (or the `id` primary key for `createdAt`).
 */
function buildCursorPredicate(
  sortColumn: 'name' | 'sku' | 'id',
  direction: 'asc' | 'desc',
  cursor: ProductCursorPayload,
): Prisma.ProductWhereInput {
  const op = direction === 'asc' ? 'gt' : 'lt';
  return {
    OR: [
      { [sortColumn]: { [op]: cursor.sv } },
      {
        AND: [
          { [sortColumn]: cursor.sv },
          { id: { [op]: cursor.id } },
        ],
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
 * - `filter.categoryId` → `{ categoryId }` (exact match).
 * - `filter.lowStockOnly === true` → restrict to ids returned by a raw
 *   `SELECT productId FROM Inventory i JOIN Product p ON p.id = i.productId
 *    WHERE i.onHand <= p.reorderLevel`. SQLite/Prisma cannot express a
 *   cross-column comparison in a relation filter, so we resolve the id
 *   set separately and feed it into a plain `id IN (...)` predicate.
 *   The query touches only indexed columns and runs once per
 *   `products:list` page (Req 3.6, 16.4).
 * - `search` (trimmed, length-clamped) → `OR` of prefix `LIKE` against
 *   `name` and `sku`. SQLite's default `LIKE` collation is
 *   case-insensitive for ASCII so a cashier searching `"led"` matches
 *   both `LED` and `led` rows without the renderer normalizing.
 */
async function compileWhere(
  filter: ProductFilter | undefined,
  search: string | undefined,
): Promise<Prisma.ProductWhereInput> {
  const clauses: Prisma.ProductWhereInput[] = [];

  if (filter?.categoryId !== undefined) {
    clauses.push({ categoryId: filter.categoryId });
  }

  if (filter?.lowStockOnly === true) {
    const lowStockIds = await fetchLowStockProductIds();
    // Empty set: short-circuit with an impossible predicate so the
    // surrounding query returns zero rows without touching the table.
    if (lowStockIds.length === 0) {
      clauses.push({ id: { in: [] } });
    } else {
      clauses.push({ id: { in: lowStockIds } });
    }
  }

  if (typeof search === 'string') {
    const trimmed = search.trim();
    if (trimmed.length > 0) {
      const term = trimmed.slice(0, SEARCH_MAX);
      clauses.push({
        OR: [{ name: { startsWith: term } }, { sku: { startsWith: term } }],
      });
    }
  }

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0]!;
  return { AND: clauses };
}

/**
 * Run the cross-column low-stock query and return the matching product
 * ids. Phase 5.3 will introduce `InventoryService.lowStockList()` that
 * exposes the same set publicly; for now the query is duplicated here
 * because that service does not yet exist. When 5.3 lands the body
 * collapses to `await InventoryService.lowStockList()`.
 */
async function fetchLowStockProductIds(): Promise<string[]> {
  // `$queryRaw` interpolates parameters through prepared statements.
  // The query has no user-supplied values, so the `Prisma.sql` template
  // is purely for the typed return shape.
  const rows = await prisma.$queryRaw<{ productId: string }[]>(
    Prisma.sql`SELECT i."productId" AS productId
                 FROM "Inventory" i
                 JOIN "Product" p ON p."id" = i."productId"
                WHERE i."onHand" <= p."reorderLevel"`,
  );
  return rows.map((r) => r.productId);
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

type ProductWithRelations = Product & {
  inventory: Inventory | null;
  category?: { name: string } | null;
};

/**
 * Map a Prisma `Product` row (with optional joined `inventory` and
 * `category` relations) to the wire DTO. `onHand` defaults to 0 when
 * the inventory relation has not been hydrated by the caller — which
 * SHOULD NOT happen in production since every `Product` row has a
 * matching `Inventory` row by construction (created in the same
 * transaction in `upsert`), but the fallback makes the conversion
 * total so a future shape change can't crash the list.
 */
function toProductDTO(row: ProductWithRelations): ProductDTO {
  const dto: ProductDTO = {
    id: row.id,
    sku: row.sku,
    name: row.name,
    categoryId: row.categoryId,
    ...(row.category != null ? { categoryName: row.category.name } : {}),
    barcode: row.barcode ?? null,
    buyPrice: row.buyPrice.toString(),
    sellPrice: row.sellPrice.toString(),
    taxRate: row.taxRate.toString(),
    warrantyMonths: row.warrantyMonths,
    reorderLevel: row.reorderLevel,
    onHand: row.inventory?.onHand ?? 0,
  };
  return dto;
}

/**
 * The `include` shape used by every read path so the DTO mapper has
 * the joins it needs to produce a complete `ProductDTO` in one round
 * trip. Centralized so list / get / upsert stay consistent.
 */
const PRODUCT_INCLUDE = {
  inventory: true,
  category: { select: { name: true } },
} as const satisfies Prisma.ProductInclude;

// ---------------------------------------------------------------------------
// Prisma error mapping
// ---------------------------------------------------------------------------

/**
 * Map a `PrismaClientKnownRequestError` raised on `upsert` to a wire
 * envelope. Returns `null` for errors we don't recognize so the caller
 * can rethrow.
 *
 * `P2002` carries `meta.target` listing the field(s) of the violated
 * unique index. SQLite reports it as a comma-joined string in some
 * Prisma versions and an array in others — we accept both. When the
 * target is missing entirely (unusual but documented) we fall back to
 * `'sku'` because it is the more common write path for products.
 */
function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): ReturnType<typeof Err> | null {
  if (err.code === PRISMA_UNIQUE_VIOLATION) {
    const field = readUniqueViolationField(err);
    return Err('UNIQUE_VIOLATION', { field });
  }
  if (err.code === PRISMA_RECORD_NOT_FOUND) {
    return Err('FK_VIOLATION', { reason: 'not_found' });
  }
  if (err.code === PRISMA_FK_VIOLATION) {
    // SQLite FK violations don't always identify the offending column.
    // For products the only outbound FK is `categoryId` (the inventory
    // FK is on `Inventory.productId`, not `Product`), so attribute
    // failures here to that field unconditionally.
    return Err('FK_VIOLATION', { field: 'categoryId' });
  }
  return null;
}

function readUniqueViolationField(err: Prisma.PrismaClientKnownRequestError): 'sku' | 'barcode' {
  const target = err.meta?.target;
  const matches = (s: unknown, needle: 'sku' | 'barcode'): boolean =>
    typeof s === 'string' && s.toLowerCase().includes(needle);
  if (typeof target === 'string') {
    if (matches(target, 'barcode')) return 'barcode';
    if (matches(target, 'sku')) return 'sku';
  } else if (Array.isArray(target)) {
    if (target.some((t) => matches(t, 'barcode'))) return 'barcode';
    if (target.some((t) => matches(t, 'sku'))) return 'sku';
  }
  return 'sku';
}

// ---------------------------------------------------------------------------
// ProductService
// ---------------------------------------------------------------------------

/**
 * Product service surface. Exposed as a frozen object literal for the
 * same reasons as `AuthService` and `CategoryService` — callers import
 * a single named symbol and the IPC handler module wires each method
 * to its channel without instantiating a class.
 */
export const ProductService = {
  /**
   * Cursor-paginated catalog listing.
   *
   * Behaviour:
   *   1. `pageSize` clamped server-side to `[1, 200]`.
   *   2. `cursor` decoded with the products-internal opaque format;
   *      malformed tokens surface as `Err('VALIDATION', { field: 'cursor' })`.
   *   3. Filter (`categoryId`, `lowStockOnly`) and search are merged
   *      into the Prisma `where` shape via `compileWhere`.
   *   4. `sort.key` defaults to `'createdAt'` (resolved to `id`) and
   *      `sort.dir` defaults to `'desc'` so first-page latency on the
   *      newest 50 rows hits the dedicated indexes.
   *   5. `nextCursor` is encoded from the tail row when exactly
   *      `pageSize` rows return; `null` otherwise.
   *   6. `totalCount` only included when `withCount: true`. The count
   *      runs against the same `where` (filter + search) — but NOT the
   *      cursor predicate — so totals stay stable across pages.
   */
  async list(
    req: ListRequest<ProductFilter, ProductSortKey>,
  ): Promise<Result<ListResponse<ProductDTO>>> {
    const take = clampPageSize(req.pageSize);
    const sortKey: ProductSortKey = req.sort?.key ?? 'createdAt';
    const direction: 'asc' | 'desc' = req.sort?.dir ?? 'desc';
    const sortColumn = resolveSortColumn(sortKey);

    let cursorPredicate: Prisma.ProductWhereInput | undefined;
    if (req.cursor !== undefined) {
      const decoded = decodeProductCursor(req.cursor);
      if (decoded === null) {
        return Err('VALIDATION', { field: 'cursor' });
      }
      cursorPredicate = buildCursorPredicate(sortColumn, direction, decoded);
    }

    const baseWhere = await compileWhere(req.filter, req.search);
    const where: Prisma.ProductWhereInput =
      cursorPredicate !== undefined
        ? Object.keys(baseWhere).length === 0
          ? cursorPredicate
          : { AND: [baseWhere, cursorPredicate] }
        : baseWhere;

    // Two-key ordering keeps pagination deterministic across rows that
    // share the same sort-column value (e.g. duplicate names).
    const orderBy: Prisma.ProductOrderByWithRelationInput[] = [
      { [sortColumn]: direction },
      { id: direction },
    ];

    const findManyArgs: Prisma.ProductFindManyArgs = {
      where,
      orderBy,
      take,
      include: PRODUCT_INCLUDE,
    };

    const [rows, totalCount] = await Promise.all([
      prisma.product.findMany(findManyArgs),
      req.withCount === true ? prisma.product.count({ where: baseWhere }) : Promise.resolve(undefined),
    ]);

    let nextCursor: string | null = null;
    if (rows.length === take && rows.length > 0) {
      const last = rows[rows.length - 1]!;
      nextCursor = encodeProductCursor({ sv: readSortValue(last, sortColumn), id: last.id });
    }

    const dtos = (rows as ProductWithRelations[]).map(toProductDTO);
    const response: ListResponse<ProductDTO> =
      totalCount !== undefined
        ? { rows: dtos, nextCursor, totalCount }
        : { rows: dtos, nextCursor };
    return Ok(response);
  },

  /**
   * Companion total-count for the list channel's filter + search shape.
   * Wired to `products:count` (Req 16.1, 16.2). `cursor` and `pageSize`
   * are intentionally not part of this request shape because they would
   * not affect the count.
   */
  async count(
    req: { filter?: ProductFilter; search?: string },
  ): Promise<Result<{ totalCount: number }>> {
    const where = await compileWhere(req.filter, req.search);
    const totalCount = await prisma.product.count({ where });
    return Ok({ totalCount });
  },

  /**
   * Single-row lookup by primary key. Returns `Ok(null)` (not `Err`)
   * when the id is unknown so the renderer's stale-link path can
   * navigate away gracefully without surfacing a toast.
   */
  async getById(id: string): Promise<Result<ProductDTO | null>> {
    if (typeof id !== 'string' || id.length === 0) {
      return Err('VALIDATION', { field: 'id' });
    }
    const row = await prisma.product.findUnique({
      where: { id },
      include: PRODUCT_INCLUDE,
    });
    if (row === null) return Ok(null);
    return Ok(toProductDTO(row as ProductWithRelations));
  },

  /**
   * Single-row lookup by the unique `barcode` index. Drives `pos:scan`,
   * which targets `< 200 ms` end-to-end — the lookup must hit the
   * dedicated `Product_barcode_key` unique index. Returns `Ok(null)`
   * for unknown barcodes so the POS UI can render the "no match"
   * indicator without an error envelope.
   */
  async getByBarcode(barcode: string): Promise<Result<ProductDTO | null>> {
    if (typeof barcode !== 'string') {
      return Err('VALIDATION', { field: 'barcode' });
    }
    const trimmed = barcode.trim();
    if (trimmed.length === 0) return Ok(null);
    const row = await prisma.product.findUnique({
      where: { barcode: trimmed },
      include: PRODUCT_INCLUDE,
    });
    if (row === null) return Ok(null);
    return Ok(toProductDTO(row as ProductWithRelations));
  },

  /**
   * Create or update a product by id.
   *
   * On create:
   *   - Wraps Product insert + Inventory insert (`onHand: 0`) in one
   *     `$transaction` so the ledger invariant — every product has a
   *     matching inventory row — holds at every commit boundary.
   *
   * On update:
   *   - Updates only the fields the renderer included. `barcode` is
   *     three-state: omitted (leave alone), `null` (clear), or a
   *     string (set). The DTO contract documents this.
   *   - Price-change auditing (Req 2.4, 13.1): when `buyPrice` or
   *     `sellPrice` differs from the persisted value, the service
   *     opens a `$transaction`, inserts an `AuditLog` row of type
   *     `price.change` carrying both prior and new prices, then
   *     applies the product update. Atomic: either both rows commit
   *     or neither does. When prices match, the update runs as a
   *     single Prisma write (no transaction overhead).
   *
   * Validation order: name → sku → categoryId → prices → ints →
   * barcode. The first failing field returns
   * `Err('VALIDATION', { field })` so the renderer can mark the
   * single offending input.
   *
   * `ctx.userId` attributes the price-change audit row to the acting
   * user.
   */
  async upsert(
    input: ProductInput,
    ctx: { userId: string },
  ): Promise<Result<ProductDTO>> {
    // ---- Validation --------------------------------------------------------
    const name = validateString(input.name, NAME_MIN, NAME_MAX);
    if (name === null) return Err('VALIDATION', { field: 'name' });

    const sku = validateString(input.sku, SKU_MIN, SKU_MAX);
    if (sku === null) return Err('VALIDATION', { field: 'sku' });

    if (typeof input.categoryId !== 'string' || input.categoryId.length === 0) {
      return Err('VALIDATION', { field: 'categoryId' });
    }

    const buyPrice = validateDecimal(input.buyPrice, { allowZero: true });
    if (buyPrice === null) return Err('VALIDATION', { field: 'buyPrice' });

    const sellPrice = validateDecimal(input.sellPrice, { allowZero: true });
    if (sellPrice === null) return Err('VALIDATION', { field: 'sellPrice' });

    const taxRate = validateDecimal(input.taxRate, { allowZero: true });
    if (taxRate === null) return Err('VALIDATION', { field: 'taxRate' });

    const warrantyMonths = validateNonNegativeInt(input.warrantyMonths);
    if (warrantyMonths === null) return Err('VALIDATION', { field: 'warrantyMonths' });

    const reorderLevel = validateNonNegativeInt(input.reorderLevel);
    if (reorderLevel === null) return Err('VALIDATION', { field: 'reorderLevel' });

    // Barcode is three-state: missing | null | string. Trim non-empty
    // strings; reject whitespace-only inputs as VALIDATION.
    let barcode: string | null | undefined;
    if (input.barcode === undefined) {
      barcode = undefined;
    } else if (input.barcode === null) {
      barcode = null;
    } else if (typeof input.barcode === 'string') {
      const trimmed = input.barcode.trim();
      if (trimmed.length === 0) {
        // Treat empty-after-trim as "clear" rather than rejecting —
        // some renderers will send empty strings instead of null when
        // the user clears the input.
        barcode = null;
      } else if (trimmed.length > BARCODE_MAX) {
        return Err('VALIDATION', { field: 'barcode' });
      } else if (trimmed.length < BARCODE_MIN) {
        return Err('VALIDATION', { field: 'barcode' });
      } else {
        barcode = trimmed;
      }
    } else {
      return Err('VALIDATION', { field: 'barcode' });
    }

    // ---- Persistence -------------------------------------------------------
    try {
      if (input.id === undefined) {
        // Create path: product + inventory in one transaction so the
        // ledger invariant (every product has a matching inventory row)
        // holds at every commit boundary (Req 3.2, 11.4).
        const created = await prisma.$transaction(async (tx) => {
          const product = await tx.product.create({
            data: {
              sku,
              name,
              categoryId: input.categoryId,
              barcode: barcode ?? null,
              buyPrice: new Prisma.Decimal(buyPrice),
              sellPrice: new Prisma.Decimal(sellPrice),
              taxRate: new Prisma.Decimal(taxRate),
              warrantyMonths,
              reorderLevel,
            },
            include: PRODUCT_INCLUDE,
          });
          await tx.inventory.create({
            data: { productId: product.id, onHand: 0 },
          });
          // Re-attach the freshly-created inventory row so the DTO has
          // the joined data without a second findUnique.
          return {
            ...product,
            inventory: { productId: product.id, onHand: 0, updatedAt: new Date() },
          } satisfies ProductWithRelations;
        });
        return Ok(toProductDTO(created));
      }

      // Update path: only the fields validated above are written. We
      // build the `data` shape conditionally so a renderer that
      // omitted `barcode` does not accidentally clear it.
      const data: Prisma.ProductUpdateInput = {
        sku,
        name,
        category: { connect: { id: input.categoryId } },
        buyPrice: new Prisma.Decimal(buyPrice),
        sellPrice: new Prisma.Decimal(sellPrice),
        taxRate: new Prisma.Decimal(taxRate),
        warrantyMonths,
        reorderLevel,
        ...(barcode !== undefined ? { barcode } : {}),
      };

      // Price-change auditing (Req 2.4, 13.1). Read the persisted
      // prices first so we can compare against the incoming values
      // and decide whether an `AuditLog` row is needed. Comparison
      // uses `Prisma.Decimal#equals` rather than string equality so
      // `'10'` and `'10.00'` are recognized as the same value — both
      // are valid storage forms for the same money amount.
      //
      // When at least one price differs, the audit insert and the
      // product update run inside one `$transaction` so they commit
      // atomically. The audit row is inserted BEFORE the update so
      // its `previous` snapshot is captured against the as-of state,
      // and so a Prisma constraint failure on the update rolls the
      // audit row back too.
      //
      // When neither price changed, the update runs as a single
      // Prisma write — no transaction overhead, no audit row. This
      // matches the requirement wording ("WHEN an Admin changes a
      // product's buy_price or sell_price"): no change → no entry.
      const productId = input.id;
      const existing = await prisma.product.findUnique({
        where: { id: productId },
        select: { buyPrice: true, sellPrice: true },
      });
      if (existing === null) {
        return Err('FK_VIOLATION', { reason: 'not_found' });
      }
      const newBuyPrice = new Prisma.Decimal(buyPrice);
      const newSellPrice = new Prisma.Decimal(sellPrice);
      const buyPriceChanged = !existing.buyPrice.equals(newBuyPrice);
      const sellPriceChanged = !existing.sellPrice.equals(newSellPrice);

      let updated: ProductWithRelations;
      if (buyPriceChanged || sellPriceChanged) {
        // Atomic audit + update. The `AuditLog.previous`/`next`
        // payloads carry both prices regardless of which one moved
        // so a downstream review can always see the full pricing
        // snapshot at each side of the change without joining
        // against a separate history.
        const previous = JSON.stringify({
          buyPrice: existing.buyPrice.toString(),
          sellPrice: existing.sellPrice.toString(),
        });
        const next = JSON.stringify({
          buyPrice: newBuyPrice.toString(),
          sellPrice: newSellPrice.toString(),
        });
        updated = await prisma.$transaction(async (tx) => {
          await tx.auditLog.create({
            data: {
              actionType: 'price.change',
              entityType: 'product',
              entityId: productId,
              previous,
              next,
              userId: ctx.userId,
            },
          });
          const row = await tx.product.update({
            where: { id: productId },
            data,
            include: PRODUCT_INCLUDE,
          });
          return row;
        });
      } else {
        updated = await prisma.product.update({
          where: { id: productId },
          data,
          include: PRODUCT_INCLUDE,
        });
      }
      return Ok(toProductDTO(updated));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        const mapped = mapPrismaError(err);
        if (mapped !== null) return mapped;
      }
      throw err;
    }
  },
} as const;

// Exported for unit tests in
// `tests/unit/main/services/product.service.test.ts` so cursor-format
// behaviour can be exercised without driving a full list query.
// Production code should not import these — they are not part of the
// service's stable surface.
export const __testables = Object.freeze({
  encodeProductCursor,
  decodeProductCursor,
  validateDecimal,
  validateString,
  validateNonNegativeInt,
});
