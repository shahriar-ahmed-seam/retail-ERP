import { describe, expect, it } from 'vitest';

import { paginateCursor, type PaginateModel } from '@main/db/paginate';
import { decodeCursor, encodeCursor } from '@shared/cursor';

/**
 * Unit tests for the `paginateCursor` helper (task 2.5.2).
 *
 * Cases covered (mirrors the task list verbatim):
 *   1. Cursor encode/decode round-trip across a synthetic 5,000-row dataset.
 *   2. `pageSize` clamping: input 0, -1, 201, 1_000_000 all clamped to [1, 200].
 *   3. `withCount` opt-in: response includes `totalCount` iff requested.
 *   4. Ascending replay direction returns the same row set as descending in reverse order.
 *   5. Walking pages from first to `nextCursor === null` yields exactly the
 *      reference query's rows in the same order (Property 16 unit-level scaffold).
 *
 * The helper is structurally typed; we drive it here with a minimal
 * in-memory mock of the Prisma delegate surface (`findMany` + `count`) so
 * the tests stay in the unit tier and never touch SQLite.
 *
 * **Validates: Requirements 16.1, 16.2, 16.3.**
 */

// ---------------------------------------------------------------------------
// In-memory mock model
// ---------------------------------------------------------------------------

interface Row {
  readonly id: string;
  readonly timestamp: Date;
  readonly category: string;
}

type OrderClause = Readonly<Record<string, 'asc' | 'desc'>>;

/**
 * Build a tiny Prisma-compatible delegate over an in-memory `Row[]`.
 *
 * Supports only the slice of `WhereInput` paginateCursor produces:
 *   - top-level `AND: [w1, w2]`
 *   - `OR: [w1, w2]`
 *   - per-key equality (`{ category: 'a' }`, `{ timestamp: dateInstance }`)
 *   - per-key comparator (`{ timestamp: { lt: date } }`,
 *     `{ id: { gt: 'x' } }`)
 *
 * Anything else is rejected so we don't silently miss a regression in
 * the helper's where shape.
 */
function makeModel(rows: readonly Row[]): PaginateModel<Row> & {
  readonly all: readonly Row[];
} {
  function matches(row: Row, where: Readonly<Record<string, unknown>> | undefined): boolean {
    if (where === undefined) return true;
    for (const [key, raw] of Object.entries(where)) {
      if (key === 'AND') {
        const arr = raw as readonly Readonly<Record<string, unknown>>[];
        if (!arr.every((w) => matches(row, w))) return false;
        continue;
      }
      if (key === 'OR') {
        const arr = raw as readonly Readonly<Record<string, unknown>>[];
        if (!arr.some((w) => matches(row, w))) return false;
        continue;
      }

      const fieldValue = (row as unknown as Readonly<Record<string, unknown>>)[key];

      if (raw instanceof Date) {
        if (!(fieldValue instanceof Date) || fieldValue.getTime() !== raw.getTime()) {
          return false;
        }
        continue;
      }

      if (raw !== null && typeof raw === 'object') {
        const cmp = raw as Readonly<Record<string, unknown>>;
        for (const [op, target] of Object.entries(cmp)) {
          if (!compareOp(fieldValue, op, target)) return false;
        }
        continue;
      }

      // Scalar equality (string / number / boolean).
      if (fieldValue !== raw) return false;
    }
    return true;
  }

  function compareOp(field: unknown, op: string, target: unknown): boolean {
    const a = field instanceof Date ? field.getTime() : field;
    const b = target instanceof Date ? target.getTime() : target;
    switch (op) {
      case 'lt':
        return (a as never) < (b as never);
      case 'lte':
        return (a as never) <= (b as never);
      case 'gt':
        return (a as never) > (b as never);
      case 'gte':
        return (a as never) >= (b as never);
      case 'equals':
        return a === b;
      default:
        throw new Error(`unsupported comparator op in mock: ${op}`);
    }
  }

  function compareRows(a: Row, b: Row, orderBy: readonly OrderClause[]): number {
    for (const clause of orderBy) {
      for (const [key, dir] of Object.entries(clause)) {
        const av = (a as unknown as Readonly<Record<string, unknown>>)[key];
        const bv = (b as unknown as Readonly<Record<string, unknown>>)[key];
        const an = av instanceof Date ? av.getTime() : av;
        const bn = bv instanceof Date ? bv.getTime() : bv;
        if ((an as never) < (bn as never)) return dir === 'asc' ? -1 : 1;
        if ((an as never) > (bn as never)) return dir === 'asc' ? 1 : -1;
      }
    }
    return 0;
  }

  return {
    all: rows,
    findMany: ({ where, orderBy, take }): Promise<Row[]> => {
      const filtered = rows.filter((r) => matches(r, where));
      filtered.sort((a, b) => compareRows(a, b, orderBy));
      return Promise.resolve(filtered.slice(0, take));
    },
    count: ({ where }): Promise<number> => {
      return Promise.resolve(rows.filter((r) => matches(r, where)).length);
    },
  };
}

/**
 * Generate `n` rows whose timestamps cluster in groups of `clusterSize`
 * sharing the exact same instant. Identical timestamps exercise the
 * tie-breaker leg of the keyset predicate (`sort = ts AND id < cursor.id`)
 * which is precisely the leg a single-column `ORDER BY` would skip past.
 */
function generateRows(n: number, opts: { clusterSize?: number } = {}): readonly Row[] {
  const cluster = opts.clusterSize ?? 7;
  const out: Row[] = [];
  const epoch = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    out.push({
      // CUID-ish ids that are NOT in lexicographic order with respect to
      // insertion: zero-pad and prefix so id-order != insertion-order.
      id: `r-${String(i).padStart(7, '0')}`,
      timestamp: new Date(epoch + Math.floor(i / cluster) * 1000),
      category: i % 2 === 0 ? 'even' : 'odd',
    });
  }
  return out;
}

function unwrapOk<T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!r.ok) throw new Error('expected Ok result');
  return r.value;
}

// ---------------------------------------------------------------------------
// 1. Cursor round-trip across a 5,000-row dataset
// ---------------------------------------------------------------------------

describe('paginateCursor — cursor round-trip', () => {
  it('encodes a nextCursor that decodes back to the last row of the page', async () => {
    const rows = generateRows(5_000);
    const model = makeModel(rows);

    const first = unwrapOk(
      await paginateCursor({ model, sortColumn: 'timestamp', pageSize: 100 }),
    );

    expect(first.rows).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();

    const last = first.rows[first.rows.length - 1]!;
    const decoded = decodeCursor(first.nextCursor!);
    expect(decoded.id).toBe(last.id);
    expect(decoded.ts.getTime()).toBe(last.timestamp.getTime());

    // And re-encoding the decoded payload reproduces the same token.
    expect(encodeCursor(decoded)).toBe(first.nextCursor);
  });
});

// ---------------------------------------------------------------------------
// 2. pageSize clamping
// ---------------------------------------------------------------------------

describe('paginateCursor — pageSize clamping', () => {
  it.each([
    [0, 1],
    [-1, 1],
    [201, 200],
    [1_000_000, 200],
  ])('clamps pageSize=%i to %i regardless of renderer input', async (input, expected) => {
    const rows = generateRows(500);
    const model = makeModel(rows);

    const captured: number[] = [];
    const wrapped: PaginateModel<Row> = {
      findMany: (args) => {
        captured.push(args.take);
        return model.findMany(args);
      },
      count: (args) => model.count!(args),
    };

    const result = unwrapOk(
      await paginateCursor({ model: wrapped, sortColumn: 'timestamp', pageSize: input }),
    );

    expect(captured[0]).toBe(expected);
    expect(result.rows.length).toBeLessThanOrEqual(expected);
  });

  it('defaults to 50 when pageSize is omitted', async () => {
    const rows = generateRows(200);
    const model = makeModel(rows);

    const captured: number[] = [];
    const wrapped: PaginateModel<Row> = {
      findMany: (args) => {
        captured.push(args.take);
        return model.findMany(args);
      },
    };

    const result = unwrapOk(await paginateCursor({ model: wrapped, sortColumn: 'timestamp' }));
    expect(captured[0]).toBe(50);
    expect(result.rows).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// 3. withCount opt-in
// ---------------------------------------------------------------------------

describe('paginateCursor — withCount opt-in', () => {
  it('omits totalCount when withCount is unset or false', async () => {
    const rows = generateRows(123);
    const model = makeModel(rows);

    const off = unwrapOk(await paginateCursor({ model, sortColumn: 'timestamp' }));
    expect('totalCount' in off).toBe(false);

    const explicitlyOff = unwrapOk(
      await paginateCursor({ model, sortColumn: 'timestamp', withCount: false }),
    );
    expect('totalCount' in explicitlyOff).toBe(false);
  });

  it('includes the filtered total when withCount is true', async () => {
    const rows = generateRows(123);
    const model = makeModel(rows);

    const result = unwrapOk(
      await paginateCursor({
        model,
        sortColumn: 'timestamp',
        withCount: true,
        where: { category: 'even' },
      }),
    );

    expect(result.totalCount).toBe(rows.filter((r) => r.category === 'even').length);
  });

  it('counts only the caller filter (not the cursor predicate) so totals are stable across pages', async () => {
    const rows = generateRows(300);
    const model = makeModel(rows);

    const first = unwrapOk(
      await paginateCursor({
        model,
        sortColumn: 'timestamp',
        pageSize: 50,
        withCount: true,
      }),
    );

    const second = unwrapOk(
      await paginateCursor({
        model,
        sortColumn: 'timestamp',
        pageSize: 50,
        cursor: first.nextCursor!,
        withCount: true,
      }),
    );

    expect(first.totalCount).toBe(rows.length);
    expect(second.totalCount).toBe(rows.length);
  });

  it('throws when withCount is requested against a model that does not expose count', async () => {
    const rows = generateRows(10);
    const model = makeModel(rows);
    const noCount: PaginateModel<Row> = { findMany: (args) => model.findMany(args) };

    await expect(
      paginateCursor({ model: noCount, sortColumn: 'timestamp', withCount: true }),
    ).rejects.toThrow(/model\.count is required/);
  });
});

// ---------------------------------------------------------------------------
// 4. Ascending replay direction is the reverse of descending
// ---------------------------------------------------------------------------

describe('paginateCursor — direction', () => {
  it("ascending walk yields the same set as descending in reverse order", async () => {
    const rows = generateRows(500);
    const model = makeModel(rows);

    const desc = await walkAll(model, 'desc', 75);
    const asc = await walkAll(model, 'asc', 75);

    expect(asc).toHaveLength(rows.length);
    expect(desc).toHaveLength(rows.length);
    expect(asc.map((r) => r.id)).toEqual([...desc].reverse().map((r) => r.id));
  });
});

// ---------------------------------------------------------------------------
// 5. Walking pages == reference query (Property 16 unit-level scaffold)
// ---------------------------------------------------------------------------

describe('paginateCursor — full walk equals reference query (Property 16 scaffold)', () => {
  it('walking pages from first to nextCursor === null yields the reference query exactly', async () => {
    const rows = generateRows(1_000, { clusterSize: 13 });
    const model = makeModel(rows);

    // Reference: rows sorted by (timestamp DESC, id DESC) — what the SQL
    // shape would produce without the LIMIT clause. Computed directly off
    // the dataset so the 200-row server-side clamp doesn't apply.
    const reference = [...rows].sort(
      (a, b) =>
        b.timestamp.getTime() - a.timestamp.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );

    const walked = await walkAll(model, 'desc', 50);
    expect(walked).toHaveLength(rows.length);
    expect(walked.map((r) => r.id)).toEqual(reference.map((r) => r.id));
  });

  it('respects the caller filter while walking', async () => {
    const rows = generateRows(600);
    const model = makeModel(rows);

    const reference = rows
      .filter((r) => r.category === 'odd')
      .sort(
        (a, b) =>
          b.timestamp.getTime() - a.timestamp.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );

    const walked = await walkAll(model, 'desc', 40, { category: 'odd' });
    expect(walked.map((r) => r.id)).toEqual(reference.map((r) => r.id));
    expect(walked.every((r) => r.category === 'odd')).toBe(true);
  });

  it('handles clusters of identical timestamps via the (sort, id) tie-breaker', async () => {
    // Every row shares the exact same timestamp; ordering must fall back to id.
    const epoch = new Date('2026-06-01T00:00:00.000Z');
    const rows: Row[] = Array.from({ length: 250 }, (_, i) => ({
      id: `r-${String(i).padStart(5, '0')}`,
      timestamp: epoch,
      category: 'fixed',
    }));
    const model = makeModel(rows);

    const walked = await walkAll(model, 'desc', 30);
    expect(walked).toHaveLength(rows.length);
    // All ids returned exactly once, in id-desc order.
    expect(walked.map((r) => r.id)).toEqual([...rows].map((r) => r.id).sort().reverse());
  });
});

// ---------------------------------------------------------------------------
// VALIDATION on bad cursor
// ---------------------------------------------------------------------------

describe('paginateCursor — malformed cursor', () => {
  it('returns Err(VALIDATION, { field: "cursor" }) for non-base64 / non-JSON / shape-violating tokens', async () => {
    const model = makeModel(generateRows(10));

    const tokens = ['not-base64!!', '%%%', 'café', btoa('not json'), btoa('{"id":"x"}')];

    for (const cursor of tokens) {
      const result = await paginateCursor({ model, sortColumn: 'timestamp', cursor });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION');
        expect(result.error.details).toEqual({ field: 'cursor' });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function walkAll(
  model: PaginateModel<Row>,
  direction: 'desc' | 'asc',
  pageSize: number,
  where?: Readonly<Record<string, unknown>>,
): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  let safety = 0;

  while (true) {
    safety++;
    if (safety > 10_000) throw new Error('walkAll: safety limit hit, possible infinite loop');

    const page = unwrapOk(
      await paginateCursor({
        model,
        sortColumn: 'timestamp',
        pageSize,
        direction,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(where !== undefined ? { where } : {}),
      }),
    );

    out.push(...page.rows);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  return out;
}
