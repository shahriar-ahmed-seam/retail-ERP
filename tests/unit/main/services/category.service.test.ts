import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `CategoryService` (Phase 4, task 4.1).
 *
 * Drives the service against an in-memory mock of the Prisma delegates
 * (`category.findMany`, `category.create`, `category.update`,
 * `category.delete`, `product.count`). The mock mimics:
 *
 *   - cuid-style id generation on create,
 *   - the unique constraint on `Category.name`,
 *   - Prisma's `P2002` (`PrismaClientKnownRequestError`) shape for
 *     unique violations,
 *   - Prisma's `P2025` shape for missing-record errors.
 *
 * The `Prisma.PrismaClientKnownRequestError` class is sourced from the
 * actual `@prisma/client` package so the service's `instanceof` check
 * exercises the same code path as production.
 *
 * Validates: Requirement 2.5.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockCategory {
    id: string;
    name: string;
  }
  interface MockProduct {
    id: string;
    categoryId: string;
  }

  const state = {
    categories: [] as MockCategory[],
    products: [] as MockProduct[],
    nextCatId: 0,
  };

  return {
    state,
    reset(): void {
      state.categories = [];
      state.products = [];
      state.nextCatId = 0;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  function makeUniqueViolation(target: string[]): unknown {
    // Construct a real PrismaClientKnownRequestError so the service's
    // `instanceof Prisma.PrismaClientKnownRequestError` check matches.
    return new Prisma.PrismaClientKnownRequestError(
      `Unique constraint failed on the fields: (\`${target.join(',')}\`)`,
      { code: 'P2002', clientVersion: 'test', meta: { target } },
    );
  }

  function makeRecordNotFound(): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      'An operation failed because it depends on one or more records that were required but not found.',
      { code: 'P2025', clientVersion: 'test' },
    );
  }

  return {
    prisma: {
      category: {
        findMany: ({
          orderBy,
        }: {
          orderBy?: { name?: 'asc' | 'desc' };
          select?: unknown;
        }) => {
          const rows = [...state.categories];
          if (orderBy?.name === 'asc') {
            rows.sort((a, b) => a.name.localeCompare(b.name));
          } else if (orderBy?.name === 'desc') {
            rows.sort((a, b) => b.name.localeCompare(a.name));
          }
          return Promise.resolve(rows.map((r) => ({ id: r.id, name: r.name })));
        },
        create: ({ data }: { data: { name: string } }) => {
          if (state.categories.some((c) => c.name === data.name)) {
            throw makeUniqueViolation(['name']);
          }
          const created = { id: `cat-${state.nextCatId++}`, name: data.name };
          state.categories.push(created);
          return Promise.resolve({ ...created });
        },
        update: ({
          where,
          data,
        }: {
          where: { id: string };
          data: { name: string };
        }) => {
          const existing = state.categories.find((c) => c.id === where.id);
          if (!existing) {
            throw makeRecordNotFound();
          }
          if (state.categories.some((c) => c.id !== where.id && c.name === data.name)) {
            throw makeUniqueViolation(['name']);
          }
          existing.name = data.name;
          return Promise.resolve({ id: existing.id, name: existing.name });
        },
        delete: ({ where }: { where: { id: string } }) => {
          const idx = state.categories.findIndex((c) => c.id === where.id);
          if (idx < 0) {
            throw makeRecordNotFound();
          }
          const [removed] = state.categories.splice(idx, 1);
          return Promise.resolve({ ...removed! });
        },
      },
      product: {
        count: ({ where }: { where?: { categoryId?: string } }) => {
          if (where?.categoryId !== undefined) {
            return Promise.resolve(
              state.products.filter((p) => p.categoryId === where.categoryId).length,
            );
          }
          return Promise.resolve(state.products.length);
        },
      },
    },
  };
});

// Imports MUST come after `vi.mock`.
import { CategoryService } from '@main/services/category.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapOk<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { code: string; details?: unknown } },
): T {
  if (!result.ok) {
    throw new Error(`expected Ok, got Err(${result.error.code})`);
  }
  return result.value;
}

beforeEach(() => {
  mockState.reset();
});

afterEach(() => {
  mockState.reset();
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('CategoryService.list', () => {
  it('returns an empty rows array on an empty table', async () => {
    const result = await CategoryService.list();
    const value = unwrapOk(result);
    expect(value.rows).toEqual([]);
  });

  it('returns rows ordered by name ascending', async () => {
    mockState.state.categories.push(
      { id: 'cat-z', name: 'Tools' },
      { id: 'cat-a', name: 'Adhesives' },
      { id: 'cat-m', name: 'Lighting' },
    );

    const result = await CategoryService.list();
    const value = unwrapOk(result);
    expect(value.rows.map((r) => r.name)).toEqual(['Adhesives', 'Lighting', 'Tools']);
  });

  it('returns DTOs with only id and name fields (no leakage)', async () => {
    mockState.state.categories.push({ id: 'cat-1', name: 'Hardware' });

    const result = await CategoryService.list();
    const value = unwrapOk(result);
    expect(value.rows).toHaveLength(1);
    expect(Object.keys(value.rows[0]!).sort()).toEqual(['id', 'name']);
  });
});

// ---------------------------------------------------------------------------
// upsert (create)
// ---------------------------------------------------------------------------

describe('CategoryService.upsert (create)', () => {
  it('creates a category when no id is supplied and returns the DTO', async () => {
    const result = await CategoryService.upsert({ name: 'Hardware' });
    const dto = unwrapOk(result);

    expect(dto.id).toBe('cat-0');
    expect(dto.name).toBe('Hardware');
    expect(mockState.state.categories).toHaveLength(1);
    expect(mockState.state.categories[0]!.name).toBe('Hardware');
  });

  it('trims surrounding whitespace from the name before persisting', async () => {
    const dto = unwrapOk(await CategoryService.upsert({ name: '   Lighting   ' }));
    expect(dto.name).toBe('Lighting');
    expect(mockState.state.categories[0]!.name).toBe('Lighting');
  });

  it('returns VALIDATION { field: "name" } on empty / whitespace-only names', async () => {
    for (const bad of ['', '   ', '\n\t']) {
      const result = await CategoryService.upsert({ name: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION');
        expect(result.error.details).toEqual({ field: 'name' });
      }
    }
    expect(mockState.state.categories).toEqual([]);
  });

  it('returns VALIDATION when name exceeds 50 characters', async () => {
    const longName = 'a'.repeat(51);
    const result = await CategoryService.upsert({ name: longName });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toEqual({ field: 'name' });
    }
  });

  it('accepts names exactly at the 50-character boundary', async () => {
    const boundaryName = 'b'.repeat(50);
    const dto = unwrapOk(await CategoryService.upsert({ name: boundaryName }));
    expect(dto.name).toBe(boundaryName);
  });

  it('returns VALIDATION when name is not a string', async () => {
    const result = await CategoryService.upsert({ name: 123 as unknown as string });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  it('maps a unique-constraint violation on name to UNIQUE_VIOLATION { field: "name" }', async () => {
    await CategoryService.upsert({ name: 'Hardware' });
    const result = await CategoryService.upsert({ name: 'Hardware' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNIQUE_VIOLATION');
      expect(result.error.details).toEqual({ field: 'name' });
    }
    // Only the first row was inserted.
    expect(mockState.state.categories).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// upsert (update)
// ---------------------------------------------------------------------------

describe('CategoryService.upsert (update)', () => {
  beforeEach(() => {
    mockState.state.categories.push(
      { id: 'cat-1', name: 'Hardware' },
      { id: 'cat-2', name: 'Lighting' },
    );
  });

  it('updates an existing category by id and returns the new name', async () => {
    const dto = unwrapOk(
      await CategoryService.upsert({ id: 'cat-1', name: 'Power Tools' }),
    );
    expect(dto.id).toBe('cat-1');
    expect(dto.name).toBe('Power Tools');
    expect(mockState.state.categories.find((c) => c.id === 'cat-1')!.name).toBe('Power Tools');
  });

  it('trims whitespace when updating', async () => {
    const dto = unwrapOk(
      await CategoryService.upsert({ id: 'cat-1', name: '  Power Tools  ' }),
    );
    expect(dto.name).toBe('Power Tools');
  });

  it('returns FK_VIOLATION { reason: "not_found" } when the id does not exist', async () => {
    const result = await CategoryService.upsert({ id: 'cat-missing', name: 'Anything' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });

  it('maps a unique-constraint violation on name to UNIQUE_VIOLATION { field: "name" }', async () => {
    // Renaming cat-1 to "Lighting" collides with cat-2's name.
    const result = await CategoryService.upsert({ id: 'cat-1', name: 'Lighting' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNIQUE_VIOLATION');
      expect(result.error.details).toEqual({ field: 'name' });
    }
    // The existing row is unchanged.
    expect(mockState.state.categories.find((c) => c.id === 'cat-1')!.name).toBe('Hardware');
  });

  it('allows updating a category to its existing name (no-op rename)', async () => {
    const dto = unwrapOk(
      await CategoryService.upsert({ id: 'cat-1', name: 'Hardware' }),
    );
    expect(dto.name).toBe('Hardware');
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('CategoryService.delete', () => {
  beforeEach(() => {
    mockState.state.categories.push(
      { id: 'cat-1', name: 'Hardware' },
      { id: 'cat-2', name: 'Lighting' },
    );
  });

  it('deletes a category that has no referencing products', async () => {
    const result = await CategoryService.delete('cat-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
    expect(mockState.state.categories.map((c) => c.id)).toEqual(['cat-2']);
  });

  it('returns FK_VIOLATION { reason: "category_in_use" } when products reference the category', async () => {
    mockState.state.products.push(
      { id: 'p-1', categoryId: 'cat-1' },
      { id: 'p-2', categoryId: 'cat-1' },
    );

    const result = await CategoryService.delete('cat-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toMatchObject({
        reason: 'category_in_use',
        productCount: 2,
      });
    }
    // Category is still in the table.
    expect(mockState.state.categories.some((c) => c.id === 'cat-1')).toBe(true);
  });

  it('does not block delete when products reference a different category', async () => {
    mockState.state.products.push({ id: 'p-1', categoryId: 'cat-2' });

    const result = await CategoryService.delete('cat-1');
    expect(result.ok).toBe(true);
    expect(mockState.state.categories.map((c) => c.id)).toEqual(['cat-2']);
  });

  it('returns FK_VIOLATION { reason: "not_found" } when the id does not exist', async () => {
    const result = await CategoryService.delete('cat-missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });

  it('returns VALIDATION on empty id input', async () => {
    const result = await CategoryService.delete('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'id' });
    }
  });
});
