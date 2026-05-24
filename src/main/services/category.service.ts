// src/main/services/category.service.ts
//
// Category domain service — list, upsert, and conditional delete for the
// `categories` reference table (Phase 4, task 4.1).
//
// Implementation choice:
//   The design's "Module breakdown" table notes "Categories — inside
//   product.service.ts" as a cohesion hint: the catalog and its
//   categorization are conceptually one module. We split them into two
//   files anyway because:
//     - The two services touch disjoint Prisma delegates (`prisma.product`
//       vs `prisma.category`) so co-locating them only forces unrelated
//       imports into one place.
//     - Categories are a small, self-contained CRUD surface (no
//       inventory writes, no audit decoration, no transactions) and are
//       trivially unit-testable in isolation.
//     - Keeping the file small leaves room for future per-domain
//       extensions (display order, color, parent category) without
//       bloating the product service.
//   The cohesion the design points at is preserved at the IPC + UI level:
//   `categories:*` channels live next to `products:*` in the contract,
//   and the renderer's products feature page surfaces category management
//   alongside product management.
//
// Responsibilities:
//   - `list()`             → return all categories ordered by name asc
//                            (Req 2.5; small reference table, no
//                            pagination envelope).
//   - `upsert(input)`      → create or update by id; trim and length-check
//                            `name`; map unique-constraint violation on
//                            `name` to `Err('UNIQUE_VIOLATION', { field:
//                            'name' })`.
//   - `delete(id)`         → delete only if no `Product` rows reference
//                            this category. Otherwise
//                            `Err('FK_VIOLATION', { reason:
//                            'category_in_use' })`. Deleting a missing
//                            category surfaces as
//                            `Err('FK_VIOLATION', { reason:
//                            'not_found' })` — failure-for-clarity per
//                            the task description, so renderers know
//                            their stale row didn't quietly succeed.
//
// All methods return `Result<T, ErrorEnvelope>`. Unhandled exceptions
// (e.g. a Prisma connection failure) bubble up so the IPC router
// middleware wraps them as `Err('INTERNAL', ..., { errorId })`.
//
// Validates: Requirement 2.5.

import { Prisma } from '@prisma/client';

import { prisma } from '@main/db/prisma.js';
import { Err, Ok, type Result } from '@shared/result.js';

import type { CategoryDTO, CategoryInput } from '@shared/dto/index.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Application-level bounds on category name length. The lower bound
 * rejects empty / whitespace-only input; the upper bound matches a
 * comfortable display width on the products list filter dropdown and
 * keeps pathological inputs out of the database. The actual SQLite
 * column has no length limit; these are app-level guardrails.
 */
const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 50;

/** Prisma's known-error code for a unique constraint violation. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** Prisma's known-error code for "record not found". */
const PRISMA_RECORD_NOT_FOUND = 'P2025';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate the application-level bounds on a category name. Returns the
 * trimmed value when valid (so callers persist the canonical form), or
 * `null` to signal a `VALIDATION` failure.
 */
function validateName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length < NAME_MIN_LENGTH || trimmed.length > NAME_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

/** Map a Prisma `Category` row to the wire DTO. */
function toCategoryDTO(row: { readonly id: string; readonly name: string }): CategoryDTO {
  return { id: row.id, name: row.name };
}

/**
 * Determine whether the unique-violation `target` field reported by
 * Prisma covers the `name` column. SQLite reports the field list in the
 * error meta as either `string` or `string[]`; we accept both shapes.
 */
function isNameUniqueViolation(err: Prisma.PrismaClientKnownRequestError): boolean {
  if (err.code !== PRISMA_UNIQUE_VIOLATION) return false;
  const target = err.meta?.target;
  if (typeof target === 'string') return target.includes('name');
  if (Array.isArray(target)) return target.some((t) => typeof t === 'string' && t.includes('name'));
  // Without target metadata, fall through: `Category` only has one
  // unique constraint (`name`), so any P2002 here must be it.
  return true;
}

// ---------------------------------------------------------------------------
// CategoryService
// ---------------------------------------------------------------------------

/**
 * Category service surface. Exposed as a frozen object literal — the
 * same style used for `AuthService` — so callers import a single named
 * symbol and the IPC handlers in `src/main/ipc/handlers/categories.ts`
 * can wire each method to its channel without instantiating a class.
 */
export const CategoryService = {
  /**
   * Return every category ordered by `name ASC`. Categories are a
   * small reference table (no expected scale beyond a few dozen rows
   * for a single shop) so this channel is intentionally unpaginated;
   * the wire shape is `{ rows: readonly CategoryDTO[] }`.
   */
  async list(): Promise<Result<{ rows: readonly CategoryDTO[] }>> {
    const rows = await prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    return Ok({ rows: rows.map(toCategoryDTO) });
  },

  /**
   * Create or update a category.
   *
   * Behaviour:
   *   1. Validate `name` (1..50 chars after trim). Returns
   *      `Err('VALIDATION', { field: 'name' })` on failure.
   *   2. If `id` is omitted, `prisma.category.create` runs; the
   *      auto-cuid id is returned in the resulting DTO.
   *   3. If `id` is supplied, `prisma.category.update` runs. A missing
   *      record surfaces as `Err('FK_VIOLATION', { reason: 'not_found' })`.
   *   4. A unique-constraint violation on `name` is mapped to
   *      `Err('UNIQUE_VIOLATION', { field: 'name' })`. Any other
   *      Prisma known error bubbles up so the router layer can wrap it
   *      as `INTERNAL`.
   */
  async upsert(input: CategoryInput): Promise<Result<CategoryDTO>> {
    const trimmedName = validateName(input.name);
    if (trimmedName === null) {
      return Err('VALIDATION', { field: 'name' });
    }

    try {
      if (input.id === undefined) {
        const created = await prisma.category.create({
          data: { name: trimmedName },
          select: { id: true, name: true },
        });
        return Ok(toCategoryDTO(created));
      }

      const updated = await prisma.category.update({
        where: { id: input.id },
        data: { name: trimmedName },
        select: { id: true, name: true },
      });
      return Ok(toCategoryDTO(updated));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (isNameUniqueViolation(err)) {
          return Err('UNIQUE_VIOLATION', { field: 'name' });
        }
        if (err.code === PRISMA_RECORD_NOT_FOUND) {
          return Err('FK_VIOLATION', { reason: 'not_found' });
        }
      }
      throw err;
    }
  },

  /**
   * Delete a category by id, but only when no products reference it.
   *
   * The pre-flight `product.count({ where: { categoryId } })` makes the
   * "in use" check explicit so the wire envelope can carry a
   * deterministic `reason: 'category_in_use'` — relying on Prisma's
   * generic FK-violation error would leak SQLite details and would
   * still race against a concurrent `Product` insert. The race window
   * is irrelevant for the single-writer main process: there is at
   * most one outstanding write at a time on this table.
   *
   * Possible outcomes:
   *   - count > 0 → `Err('FK_VIOLATION', { reason: 'category_in_use' })`.
   *   - count === 0 and the row exists → delete and return `Ok(undefined)`.
   *   - count === 0 and the row is missing → `Err('FK_VIOLATION',
   *     { reason: 'not_found' })`. This is the "failure-for-clarity"
   *     branch chosen in the task description: a renderer that fired
   *     a stale delete sees an explicit error rather than a silent
   *     succeed-but-nothing-happened.
   */
  async delete(id: string): Promise<Result<void>> {
    if (typeof id !== 'string' || id.length === 0) {
      return Err('VALIDATION', { field: 'id' });
    }

    const referencingProducts = await prisma.product.count({
      where: { categoryId: id },
    });
    if (referencingProducts > 0) {
      return Err('FK_VIOLATION', {
        reason: 'category_in_use',
        productCount: referencingProducts,
      });
    }

    try {
      await prisma.category.delete({ where: { id } });
      return Ok(undefined);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === PRISMA_RECORD_NOT_FOUND
      ) {
        return Err('FK_VIOLATION', { reason: 'not_found' });
      }
      throw err;
    }
  },
} as const;
