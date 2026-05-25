// src/main/services/audit.service.ts
//
// Audit log read service (Phase 12, task 12.1).
//
// `AuditLog` is append-only (Req 13.4) — no service ever updates or
// deletes rows; every write happens inline inside the originating
// business transaction (`product.service` for `price.change`,
// `inventory.service` for `stock.adjust`, `auth.service` for
// `role.change`, the IPC router middleware for `rbac.deny`). This
// module is therefore READ-ONLY: it exposes the `audit:list` /
// `audit:count` channels that drive the Admin-only audit log viewer
// (`src/renderer/features/users/AuditLogPage.tsx`, task 12.1).
//
// The list path:
//
//   1. Compiles the renderer-supplied `AuditFilter`
//      (`actionType`, `userId`, `dateFrom`, `dateTo`) into a
//      Prisma-style `where` shape. The filter columns map 1:1 onto
//      indexed columns on the `AuditLog` table — `actionType` is
//      indexed via `@@index([actionType])`, `timestamp` via the
//      `@@index([timestamp])` and the cursor-targeted
//      `@@index([timestamp(sort: Desc), id])`. `userId` is not
//      individually indexed today, but the filter is rare and the
//      composite cursor index keeps the worst case bounded; if the
//      `userId` filter ever becomes a hot path it can be promoted to
//      its own composite index without changing this module.
//
//   2. Drives pagination through the shared `paginateCursor` helper
//      (`src/main/db/paginate.ts`) so cursor decoding, page-size
//      clamping, `nextCursor` semantics, and the `withCount` opt-in
//      stay consistent with every other list channel in the IPC
//      contract (Req 16.1, 16.2, 16.3).
//
//   3. Sort is fixed to `(timestamp DESC, id DESC)` — the
//      `AuditSortKey` union narrows to the literal `'timestamp'` so
//      the renderer cannot ask for an unindexed sort column. The
//      direction defaults to descending (newest first), which is
//      what the cursor index supports as a single forward seek.
//
//   4. Joins the optional `userId` to the `User` table by ad-hoc
//      `findMany` so the row DTO carries `userName` alongside
//      `userId`. Prisma does not declare a `userId → User` relation
//      on `AuditLog` (the column is nullable and the column name is
//      bare `userId`, not a relation field), so the join is done
//      via a single follow-up `User.findMany({ where: { id: in:
//      [...] } })` rather than via `include`. This is one extra
//      indexed `IN` lookup per page and stays well under the
//      < 100 ms p95 first-page target on a million-row table
//      (Req 16.9).
//
// The companion count path is the same `where` compilation against
// `prisma.auditLog.count({ where })` — no cursor, no joins.
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.4, 16.1, 16.2, 16.3,
//            16.4.

import { type AuditLog, Prisma } from '@prisma/client';

import {
  paginateCursor,
  type PaginateModel,
  type PaginateWhere,
} from '@main/db/paginate.js';
import { prisma } from '@main/db/prisma.js';
import { Ok, type Result } from '@shared/result.js';

import type {
  AuditActionType,
  AuditFilter,
  AuditLogDTO,
  AuditSortKey,
} from '@shared/dto/index.js';
import type { ListRequest, ListResponse } from '@shared/ipc-contract.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Default ISO 8601 sentinel timestamps used when only one bound is
 *  supplied for a date-range filter. Matches the
 *  `inventory.service#compileMovementWhere` convention so SQLite's
 *  planner picks the composite cursor index regardless of which side
 *  is bounded. */
const MIN_TS = new Date('1970-01-01T00:00:00.000Z');
const MAX_TS = new Date('9999-12-31T23:59:59.999Z');

// ---------------------------------------------------------------------------
// Filter compilation
// ---------------------------------------------------------------------------

/**
 * Compile the renderer-supplied `AuditFilter` into the opaque-where
 * shape `paginateCursor` forwards into `findMany` / `count`.
 *
 * Filter rules:
 *
 *   - `actionType`  → exact match against the indexed column. Empty
 *                     / non-string values are dropped silently;
 *                     `AuditActionType` is a closed string union, so
 *                     a stray value here is a programmer bug, not
 *                     user input.
 *   - `userId`      → exact match. Empty strings are ignored so a
 *                     renderer that submitted "" by mistake doesn't
 *                     match every system-originated row (the column
 *                     is nullable; a real "no user" filter would
 *                     have to be a separate UI control).
 *   - `dateFrom`/
 *     `dateTo`      → inclusive `[gte, lte]` window against
 *                     `timestamp`. Either bound may be omitted; the
 *                     missing side is filled with a sentinel so a
 *                     single-sided window still serializes as a
 *                     range predicate.
 *
 * Invalid date strings are silently dropped (the renderer's date
 * picker is responsible for emitting well-formed ISO strings).
 */
function compileAuditWhere(filter: AuditFilter | undefined): PaginateWhere {
  const where: Record<string, unknown> = {};
  if (filter === undefined) return where;

  if (typeof filter.actionType === 'string' && filter.actionType.length > 0) {
    where.actionType = filter.actionType;
  }

  if (typeof filter.userId === 'string' && filter.userId.length > 0) {
    where.userId = filter.userId;
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

// ---------------------------------------------------------------------------
// Paginated model wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap `prisma.auditLog` so it satisfies the structural
 * `PaginateModel<AuditLog>` contract. Unlike the inventory-movement
 * wrapper this one does NOT attach a Prisma `include` — the
 * `AuditLog.userId` column is a bare nullable string with no
 * declared relation, so the join is done as a separate batched
 * lookup after the page is loaded (see {@link list} below).
 */
function makePaginatedAuditModel(): PaginateModel<AuditLog> {
  const model: PaginateModel<AuditLog> = {
    async findMany(args) {
      const findArgs: Prisma.AuditLogFindManyArgs = {
        orderBy: args.orderBy as unknown as Prisma.AuditLogOrderByWithRelationInput[],
        take: args.take,
        ...(args.where !== undefined ? { where: args.where } : {}),
      };
      return prisma.auditLog.findMany(findArgs);
    },
    count(args) {
      const countArgs: Prisma.AuditLogCountArgs =
        args.where !== undefined ? { where: args.where } : {};
      return prisma.auditLog.count(countArgs);
    },
  };
  return model;
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

/**
 * Project a raw `AuditLog` row plus its resolved username into the
 * cross-process `AuditLogDTO`. Both `previous` and `next` are
 * persisted as JSON strings (or `null` when the action has no
 * meaningful before/after snapshot — e.g. `rbac.deny`); the DTO
 * surfaces them as `unknown` so the renderer can render a generic
 * before/after diff without per-action-type narrowing in this
 * service.
 *
 * `actionType` is cast through the closed `AuditActionType` union
 * because the SQLite column is `String` and Prisma cannot narrow it
 * automatically. Rows with stray action-type values render as their
 * raw string label in the renderer (no schema coercion), which is
 * the desired behaviour for forward-compatibility with new action
 * types added by future phases.
 */
function toAuditLogDTO(
  row: AuditLog,
  userName: string | null,
): AuditLogDTO {
  return {
    id: row.id,
    actionType: row.actionType as AuditActionType,
    entityType: row.entityType,
    entityId: row.entityId,
    previous: parseJsonOrNull(row.previous),
    next: parseJsonOrNull(row.next),
    userId: row.userId,
    userName,
    timestamp: row.timestamp.toISOString(),
  };
}

/** Defensive JSON parse — returns `null` on missing or malformed
 *  input rather than throwing. The audit writer always stringifies
 *  via `JSON.stringify`, so a malformed value indicates manual DB
 *  tampering and the renderer is fine surfacing it as `null`. */
function parseJsonOrNull(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Cursor-paginated audit-log list (`audit:list`).
 *
 * Behaviour:
 *
 *   1. Compile the filter into a Prisma where shape via
 *      `compileAuditWhere`.
 *   2. Run pagination through the shared `paginateCursor` helper
 *      against `(timestamp DESC, id DESC)`. Sort key is fixed to
 *      `'timestamp'` (the only literal in `AuditSortKey`); direction
 *      defaults to `'desc'`.
 *   3. After the page is loaded, batch-look up every distinct
 *      `userId` referenced on the page via a single
 *      `prisma.user.findMany({ where: { id: { in: [...] } } })` so
 *      each row DTO can carry `userName` alongside `userId`. Rows
 *      with `userId === null` (system-originated entries) keep
 *      `userName: null`.
 *   4. Project each row to `AuditLogDTO` and return the standard
 *      `ListResponse<AuditLogDTO>` envelope.
 *
 * Validates: Requirements 13.1, 13.2, 13.3, 13.4, 16.1, 16.2, 16.3,
 *            16.4.
 */
async function list(
  req: ListRequest<AuditFilter, AuditSortKey>,
): Promise<Result<ListResponse<AuditLogDTO>>> {
  const where = compileAuditWhere(req.filter);
  const direction: 'desc' | 'asc' = req.sort?.dir ?? 'desc';

  const paginateOpts = {
    model: makePaginatedAuditModel(),
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

  // Resolve userId → username with one batched lookup. `Set` removes
  // the duplicates that come from many actions by the same admin
  // (the common case on this surface).
  const userIds: string[] = [];
  for (const row of result.value.rows) {
    if (row.userId !== null && !userIds.includes(row.userId)) {
      userIds.push(row.userId);
    }
  }
  const userMap = new Map<string, string>();
  if (userIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true },
    });
    for (const u of users) userMap.set(u.id, u.username);
  }

  const dtoRows = result.value.rows.map((row) =>
    toAuditLogDTO(row, row.userId === null ? null : userMap.get(row.userId) ?? null),
  );

  const response: ListResponse<AuditLogDTO> =
    result.value.totalCount !== undefined
      ? { rows: dtoRows, nextCursor: result.value.nextCursor, totalCount: result.value.totalCount }
      : { rows: dtoRows, nextCursor: result.value.nextCursor };
  return Ok(response);
}

/**
 * Companion total-count for `audit:list`. Wired to `audit:count`;
 * cursor and pageSize are intentionally not part of this request
 * shape because they would not affect the count.
 *
 * Validates: Requirements 16.1, 16.2.
 */
async function count(
  req: { filter?: AuditFilter; search?: string },
): Promise<Result<{ totalCount: number }>> {
  const where = compileAuditWhere(req.filter) as Prisma.AuditLogWhereInput;
  const totalCount = await prisma.auditLog.count({ where });
  return Ok({ totalCount });
}

/**
 * Audit log read service. Append-only (Req 13.4): writes happen
 * inline inside the originating business `$transaction` in their
 * owning service (price changes in `product.service`, stock
 * adjustments in `inventory.service`, role changes in
 * `auth.service`) or in the IPC router middleware (`rbac.deny`).
 * This service exposes only the list / count read surface that
 * drives the Admin-only audit log viewer.
 */
export const AuditService = Object.freeze({
  list,
  count,
} as const);
