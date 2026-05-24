// src/main/db/paginate.ts
//
// Generic cursor-pagination helper used by every `*:list` IPC channel
// (Phase 2.5, task 2.5.1).
//
// All paginated list channels share one envelope (`ListRequest` /
// `ListResponse` in `src/shared/ipc-contract.ts`) and one cursor format
// (`base64(JSON({ ts, id }))` from `src/shared/cursor.ts`). The SQL shape
// is canonical (design.md > "List channel pagination contract"):
//
//   WHERE <filter> AND (sort_col, id) < (?, ?)
//   ORDER BY sort_col DESC, id DESC
//   LIMIT pageSize
//
// SQLite has no native tuple comparator inside Prisma, so the keyset
// predicate is expanded to its OR form:
//
//   sort_col < ts                           -- strictly older row
//     OR (sort_col = ts AND id < cursor.id) -- same instant, lower id
//
// For ascending walks (used by `replayJournal`, design.md >
// "Batched, memory-bounded replay") `<` flips to `>` and `DESC` to `ASC`;
// the same composite `(sort_col, id)` index serves both directions.
//
// The helper is structurally typed on a minimal `PaginateModel` interface
// rather than a Prisma delegate so unit tests can drive it with an
// in-memory mock and so the implementation does not depend on any
// generated Prisma types. Every list service in `src/main/services/` is
// required to call this helper rather than rolling its own cursor SQL.
//
// Validates: Requirements 15.4, 16.1, 16.2, 16.3, 16.4, 16.9.

import { CursorDecodeError, clampPageSize, decodeCursor, encodeCursor } from '@shared/cursor.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type { ListResponse } from '@shared/ipc-contract.js';

// ---------------------------------------------------------------------------
// Structural model interface
// ---------------------------------------------------------------------------
//
// We deliberately do not import Prisma's delegate types here. Each Prisma
// model exposes `findMany` and `count` with broadly compatible signatures;
// a structural type with the exact subset we use keeps this module
// type-checkable without `@prisma/client` and lets unit tests substitute a
// trivial in-memory implementation.
//
// `Where` is `Record<string, unknown>` because every Prisma model has a
// different `*WhereInput`; the helper only ever forwards opaque where
// shapes through to the model. The caller is responsible for shape
// correctness for the specific delegate it passes in.

/** Filter shape forwarded to the underlying model — opaque to this helper. */
export type PaginateWhere = Readonly<Record<string, unknown>>;

/** Order specification forwarded to `findMany`. */
export type PaginateOrderBy = readonly Readonly<Record<string, 'asc' | 'desc'>>[];

/** Argument shape `paginateCursor` passes to `model.findMany`. */
export interface PaginateFindManyArgs {
  readonly where?: PaginateWhere;
  readonly orderBy: PaginateOrderBy;
  readonly take: number;
}

/** Argument shape `paginateCursor` passes to `model.count`. */
export interface PaginateCountArgs {
  readonly where?: PaginateWhere;
}

/**
 * Minimal Prisma-like delegate the helper requires. Every Prisma model
 * matches this shape (the actual signatures are wider but compatible).
 */
export interface PaginateModel<TRow> {
  findMany(args: PaginateFindManyArgs): Promise<TRow[]>;
  count?: (args: PaginateCountArgs) => Promise<number>;
}

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link paginateCursor}.
 *
 * `direction` defaults to `'desc'` — the list-channel default surfaced
 * to renderers. `replayJournal` (design.md > "Batched, memory-bounded
 * replay") passes `'asc'` to walk the journal forward from the latest
 * snapshot timestamp.
 */
export interface PaginateOptions<TRow extends { readonly id: string }> {
  /** Prisma delegate (or compatible mock) the helper queries. */
  readonly model: PaginateModel<TRow>;
  /**
   * Name of the timestamp-typed column the cursor sorts by, e.g.
   * `'createdAt'` for `Sale`, `'timestamp'` for `InventoryMovement` /
   * `AuditLog` / `JournalEntry`.
   */
  readonly sortColumn: string;
  /** Channel-specific filter / search predicate, already compiled to a
   *  Prisma-style where shape by the caller. */
  readonly where?: PaginateWhere;
  /** Opaque cursor from the previous page; omit on first page. */
  readonly cursor?: string;
  /** Renderer-supplied page size; clamped server-side to [1, 200]. */
  readonly pageSize?: number;
  /** Sort direction. Defaults to `'desc'` (newest first). */
  readonly direction?: 'desc' | 'asc';
  /** Opt-in `COUNT(*)`; omitted from the response otherwise. */
  readonly withCount?: boolean;
}

// ---------------------------------------------------------------------------
// paginateCursor
// ---------------------------------------------------------------------------

/**
 * Cursor-paginate any model that exposes a Prisma-like `findMany` (and an
 * optional `count`).
 *
 * Behaviour summary:
 *   1. `pageSize` is clamped server-side to `[1, 200]` via
 *      {@link clampPageSize} regardless of renderer input (Req 16.1).
 *   2. `cursor`, when present, is decoded via
 *      {@link decodeCursor}; malformed tokens surface as
 *      `Err('VALIDATION', { field: 'cursor' })` (Req 16.3).
 *   3. The cursor predicate is expressed as the OR-expansion of the
 *      tuple comparator `(sortColumn, id) < (ts, id)` so SQLite can use
 *      the composite `(sortColumn DESC, id)` index without a sort
 *      step (Req 15.4, 16.4).
 *   4. `nextCursor` is encoded from the last row of the page when
 *      exactly `pageSize` rows are returned; otherwise it is `null`
 *      (Req 16.2 — the page completes the result set).
 *   5. `totalCount` is included iff `withCount: true`. The `COUNT(*)`
 *      runs against the caller's `where` only (cursor predicate
 *      excluded) so the total is stable across pages (Req 16.1).
 *
 * The helper does not retry on transient Prisma errors and does not
 * translate generic database failures — those bubble up so the IPC
 * router middleware can surface them as `INTERNAL` with a log
 * correlation id.
 */
export async function paginateCursor<TRow extends { readonly id: string }>(
  opts: PaginateOptions<TRow>,
): Promise<Result<ListResponse<TRow>>> {
  const { model, sortColumn, where, cursor, pageSize, direction = 'desc', withCount } = opts;

  // 1. Clamp page size before any DB work so we always issue a bounded query.
  const take = clampPageSize(pageSize);

  // 2. Decode the cursor — the only path that maps to VALIDATION.
  let cursorPayload: { ts: Date; id: string } | undefined;
  if (cursor !== undefined) {
    try {
      cursorPayload = decodeCursor(cursor);
    } catch (e) {
      if (e instanceof CursorDecodeError) {
        return Err('VALIDATION', { field: 'cursor' });
      }
      throw e;
    }
  }

  // 3. Build the cursor predicate (keyset comparator OR-expansion).
  const cursorWhere = cursorPayload
    ? buildCursorWhere(sortColumn, cursorPayload, direction)
    : undefined;

  // 4. Compose with the caller's where via AND so any top-level OR/AND in
  //    the caller's shape is preserved untouched.
  const composedWhere = composeWhere(where, cursorWhere);

  // 5. Order by (sortColumn, id) in the requested direction. Two-key
  //    ordering is required so cursor pagination remains deterministic
  //    across rows with identical sort-column values.
  const orderBy: PaginateOrderBy = [{ [sortColumn]: direction }, { id: direction }];

  // 6. Issue findMany and (optionally) count in parallel — both queries
  //    are independent of each other.
  const findManyArgs: PaginateFindManyArgs = composedWhere !== undefined
    ? { where: composedWhere, orderBy, take }
    : { orderBy, take };

  const countArgs: PaginateCountArgs = where !== undefined ? { where } : {};

  const [rows, totalCount] = await Promise.all([
    model.findMany(findManyArgs),
    withCount === true ? requireCount(model)(countArgs) : Promise.resolve(undefined),
  ]);

  // 7. Compute nextCursor. A page that returned fewer than `take` rows
  //    is by definition the last page (Req 16.2); encode the tail row's
  //    `(sortColumn, id)` otherwise.
  let nextCursor: string | null = null;
  if (rows.length === take && rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last !== undefined) {
      const ts = readSortValue(last, sortColumn);
      nextCursor = encodeCursor({ ts, id: last.id });
    }
  }

  // 8. Build the response. `totalCount` is only set when withCount was
  //    requested (and was therefore awaited above) — exactOptional
  //    optional types require us to omit the key entirely otherwise.
  const response: ListResponse<TRow> =
    totalCount !== undefined
      ? { rows, nextCursor, totalCount }
      : { rows, nextCursor };

  return Ok(response);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the keyset cursor predicate for the requested direction.
 *
 * Descending walk (default, list view):
 *   sort < ts OR (sort = ts AND id < cursor.id)
 *
 * Ascending walk (replayJournal):
 *   sort > ts OR (sort = ts AND id > cursor.id)
 *
 * The OR-expansion is what the SQLite query planner can resolve as an
 * indexed seek + bounded scan against the `(sort DESC, id)` composite
 * index declared on Sale, InventoryMovement, AuditLog, and JournalEntry.
 */
function buildCursorWhere(
  sortColumn: string,
  cursor: { ts: Date; id: string },
  direction: 'desc' | 'asc',
): PaginateWhere {
  const op = direction === 'desc' ? 'lt' : 'gt';
  return {
    OR: [
      { [sortColumn]: { [op]: cursor.ts } },
      {
        AND: [{ [sortColumn]: cursor.ts }, { id: { [op]: cursor.id } }],
      },
    ],
  };
}

/**
 * Compose the caller's where (filter + search) with the cursor predicate.
 *
 * Prisma supports a top-level `AND: [...]` array which preserves both
 * operands' shape — this is preferred over key-merging because the
 * caller's where might itself contain a top-level `OR` that would
 * collide with the cursor predicate's `OR`.
 */
function composeWhere(
  caller: PaginateWhere | undefined,
  cursorWhere: PaginateWhere | undefined,
): PaginateWhere | undefined {
  if (caller === undefined && cursorWhere === undefined) return undefined;
  if (caller === undefined) return cursorWhere;
  if (cursorWhere === undefined) return caller;
  return { AND: [caller, cursorWhere] };
}

/**
 * Read the sort-column value off a row and narrow it to the
 * `Date | string` accepted by {@link encodeCursor}.
 *
 * Prisma materializes SQLite `DATETIME` columns as JavaScript `Date`
 * instances; ISO strings are accepted too because the encoder normalizes
 * via `toISOString()` and tests sometimes substitute strings to keep
 * fixtures readable.
 */
function readSortValue(row: { readonly id: string }, key: string): Date | string {
  const value = (row as Readonly<Record<string, unknown>>)[key];
  if (value instanceof Date) return value;
  if (typeof value === 'string') return value;
  throw new TypeError(
    `paginateCursor: row.${key} must be a Date or ISO string (got ${typeof value})`,
  );
}

/**
 * Pull `count` off the model with a clear runtime error when the caller
 * asked for `withCount: true` against a model that did not expose it.
 *
 * This is a programmer error (every Prisma model exposes `count`); the
 * unit tests cover the negative case to keep the message accurate.
 */
function requireCount<TRow>(
  model: PaginateModel<TRow>,
): (args: PaginateCountArgs) => Promise<number> {
  if (model.count === undefined) {
    throw new TypeError('paginateCursor: model.count is required when withCount=true');
  }
  return model.count.bind(model);
}
