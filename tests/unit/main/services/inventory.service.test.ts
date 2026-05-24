import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `InventoryService.applyMovement` (Phase 5, task 5.1)
 * and `InventoryService.adjust` (Phase 5, task 5.2).
 *
 * Drives the helpers against an in-memory mock of the Prisma delegates
 * each path touches inside its `$transaction`:
 *   - `applyMovement`: `inventory.findUniqueOrThrow` (point read on
 *     the PK), `inventory.update` (absolute on-hand assignment),
 *     `inventoryMovement.create` (single ledger insert).
 *   - `adjust`: the above plus `auditLog.create` (one `stock.adjust`
 *     row) and `journalEntry.create` (one `adjustment` row).
 * The shared `$transaction` wrapper hands the helper a tx-shaped
 * delegate map and snapshots/rolls-back state on a thrown exception
 * so tests can observe the no-write semantics of `OutOfStockError`
 * AND the all-or-nothing semantics of `adjust` (audit + journal +
 * movement either all commit or none do).
 *
 * The mock matches the pattern established by
 * `tests/unit/main/services/product.service.test.ts` so future
 * inventory tests (low-stock queries) can extend the same fixture.
 *
 * Validates: Requirements 3.1, 3.2, 3.5, 3.7, 11.1, 11.4, 13.3.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockInventory {
    productId: string;
    onHand: number;
    updatedAt: Date;
  }
  interface MockMovement {
    id: string;
    productId: string;
    quantityDelta: number;
    movementType: string;
    referenceType: string;
    referenceId: string;
    userId: string;
    timestamp: Date;
  }
  interface MockAuditLog {
    id: string;
    actionType: string;
    entityType: string;
    entityId: string;
    previous: string | null;
    next: string | null;
    userId: string | null;
    timestamp: Date;
  }
  interface MockJournalEntry {
    id: string;
    opType: string;
    payload: string;
    timestamp: Date;
  }
  interface MockProduct {
    id: string;
    sku: string;
    name: string;
    reorderLevel: number;
  }
  interface MockUser {
    id: string;
    username: string;
  }

  const state = {
    inventories: [] as MockInventory[],
    movements: [] as MockMovement[],
    auditLogs: [] as MockAuditLog[],
    journalEntries: [] as MockJournalEntry[],
    products: [] as MockProduct[],
    users: [] as MockUser[],
    nextMovementId: 0,
    nextAuditId: 0,
    nextJournalId: 0,
  };

  return {
    state,
    reset(): void {
      state.inventories = [];
      state.movements = [];
      state.auditLogs = [];
      state.journalEntries = [];
      state.products = [];
      state.users = [];
      state.nextMovementId = 0;
      state.nextAuditId = 0;
      state.nextJournalId = 0;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  type MockInventory = (typeof state.inventories)[number];
  type MockMovement = (typeof state.movements)[number];
  type MockAuditLog = (typeof state.auditLogs)[number];
  type MockJournalEntry = (typeof state.journalEntries)[number];

  function makeRecordNotFound(): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      'No Inventory found',
      { code: 'P2025', clientVersion: 'test' },
    );
  }

  function inventoryFindUniqueOrThrowImpl({
    where,
  }: {
    where: { productId: string };
  }): Promise<MockInventory> {
    const row = state.inventories.find((i) => i.productId === where.productId);
    if (!row) throw makeRecordNotFound();
    // Return a fresh object so the caller can't mutate stored state by
    // reference — matches Prisma's actual behaviour.
    return Promise.resolve({ ...row });
  }

  function inventoryUpdateImpl({
    where,
    data,
  }: {
    where: { productId: string };
    data: { onHand: number };
  }): Promise<MockInventory> {
    const row = state.inventories.find((i) => i.productId === where.productId);
    if (!row) throw makeRecordNotFound();
    row.onHand = data.onHand;
    row.updatedAt = new Date();
    return Promise.resolve({ ...row });
  }

  function inventoryMovementCreateImpl({
    data,
  }: {
    data: {
      productId: string;
      quantityDelta: number;
      movementType: string;
      referenceType: string;
      referenceId: string;
      userId: string;
    };
  }): Promise<MockMovement> {
    const row: MockMovement = {
      id: `mov-${state.nextMovementId++}`,
      productId: data.productId,
      quantityDelta: data.quantityDelta,
      movementType: data.movementType,
      referenceType: data.referenceType,
      referenceId: data.referenceId,
      userId: data.userId,
      timestamp: new Date(),
    };
    state.movements.push(row);
    return Promise.resolve({ ...row });
  }

  function auditLogCreateImpl({
    data,
  }: {
    data: {
      actionType: string;
      entityType: string;
      entityId: string;
      previous?: string | null;
      next?: string | null;
      userId?: string | null;
    };
  }): Promise<MockAuditLog> {
    const row: MockAuditLog = {
      id: `audit-${state.nextAuditId++}`,
      actionType: data.actionType,
      entityType: data.entityType,
      entityId: data.entityId,
      previous: data.previous ?? null,
      next: data.next ?? null,
      userId: data.userId ?? null,
      timestamp: new Date(),
    };
    state.auditLogs.push(row);
    return Promise.resolve({ ...row });
  }

  function journalEntryCreateImpl({
    data,
  }: {
    data: { opType: string; payload: string };
  }): Promise<MockJournalEntry> {
    const row: MockJournalEntry = {
      id: `journal-${state.nextJournalId++}`,
      opType: data.opType,
      payload: data.payload,
      timestamp: new Date(),
    };
    state.journalEntries.push(row);
    return Promise.resolve({ ...row });
  }

  // The inventory service uses `prisma.$queryRaw` with `Prisma.sql`
  // for the cross-column low-stock predicate
  // (`Inventory.onHand <= Product.reorderLevel`). The template
  // function returns an opaque object that carries the SQL fragments
  // on a `strings` (TemplateStringsArray) field; we sniff a marker
  // word to decide which of the two queries (`COUNT(*)` for
  // `lowStockCount`, the projection for `lowStockList`) the service
  // is running, then compute the answer against the in-memory
  // products + inventories.
  function isCountSql(arg: unknown): boolean {
    const sql = readSqlText(arg);
    return /count\s*\(\s*\*\s*\)/i.test(sql);
  }

  function readSqlText(arg: unknown): string {
    if (arg === null || typeof arg !== 'object') return '';
    const maybe = (arg as { strings?: ArrayLike<string>; sql?: unknown; text?: unknown });
    if (maybe.strings !== undefined) {
      return Array.from(maybe.strings).join(' ');
    }
    if (typeof maybe.sql === 'string') return maybe.sql;
    if (typeof maybe.text === 'string') return maybe.text;
    return '';
  }

  function joinedLowStockRows(): {
    productId: string;
    sku: string;
    name: string;
    onHand: number;
    reorderLevel: number;
  }[] {
    const out: {
      productId: string;
      sku: string;
      name: string;
      onHand: number;
      reorderLevel: number;
    }[] = [];
    for (const inv of state.inventories) {
      const prod = state.products.find((p) => p.id === inv.productId);
      if (!prod) continue;
      if (inv.onHand <= prod.reorderLevel) {
        out.push({
          productId: inv.productId,
          sku: prod.sku,
          name: prod.name,
          onHand: inv.onHand,
          reorderLevel: prod.reorderLevel,
        });
      }
    }
    // Mirror the SQL: ORDER BY reorderLevel DESC, onHand ASC, name ASC.
    out.sort((a, b) => {
      if (b.reorderLevel !== a.reorderLevel) return b.reorderLevel - a.reorderLevel;
      if (a.onHand !== b.onHand) return a.onHand - b.onHand;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  function queryRawImpl(arg: unknown): Promise<unknown[]> {
    if (isCountSql(arg)) {
      return Promise.resolve([{ count: joinedLowStockRows().length }]);
    }
    return Promise.resolve(joinedLowStockRows());
  }

  // -------------------------------------------------------------------------
  // InventoryMovement.findMany / .count — used by listMovements +
  // countMovements (Phase 5, task 5.5.1). The mock supports the slice
  // of `WhereInput` paginateCursor produces (top-level AND/OR, scalar
  // equality, `gte`/`lte` on `timestamp`, `lt`/`gt` keyset on
  // `timestamp` and `id`) plus the additional `productId` /
  // `movementType` equality predicates compileMovementWhere emits.
  // ORDER BY (timestamp, id) is honoured to drive the cursor walk and
  // the joined `product` / `user` relations are attached when the
  // caller asks via `include` so the DTO mapping has a productName /
  // userName to project. The findMany return shape is defined once in
  // the helper below; the cast at the call-site keeps Prisma's
  // generated type happy without losing the joined columns.
  function matchesMovement(
    row: MockMovement,
    where: Readonly<Record<string, unknown>> | undefined,
  ): boolean {
    if (where === undefined) return true;
    for (const [key, raw] of Object.entries(where)) {
      if (key === 'AND') {
        const arr = raw as readonly Readonly<Record<string, unknown>>[];
        if (!arr.every((w) => matchesMovement(row, w))) return false;
        continue;
      }
      if (key === 'OR') {
        const arr = raw as readonly Readonly<Record<string, unknown>>[];
        if (!arr.some((w) => matchesMovement(row, w))) return false;
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
          if (!compareMovementOp(fieldValue, op, target)) return false;
        }
        continue;
      }
      if (fieldValue !== raw) return false;
    }
    return true;
  }

  function compareMovementOp(field: unknown, op: string, target: unknown): boolean {
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
        throw new Error(`unsupported comparator op in movement mock: ${op}`);
    }
  }

  function compareMovementRows(
    a: MockMovement,
    b: MockMovement,
    orderBy: readonly Readonly<Record<string, 'asc' | 'desc'>>[],
  ): number {
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

  function inventoryMovementFindManyImpl(args: {
    where?: Readonly<Record<string, unknown>>;
    orderBy?: readonly Readonly<Record<string, 'asc' | 'desc'>>[];
    take?: number;
    include?: { product?: unknown; user?: unknown };
  }): Promise<unknown[]> {
    const filtered = state.movements.filter((m) => matchesMovement(m, args.where));
    if (args.orderBy !== undefined) {
      filtered.sort((a, b) => compareMovementRows(a, b, args.orderBy!));
    }
    const limited = args.take !== undefined ? filtered.slice(0, args.take) : filtered;
    return Promise.resolve(
      limited.map((row) => {
        const base: Record<string, unknown> = { ...row };
        if (args.include?.product !== undefined) {
          const prod = state.products.find((p) => p.id === row.productId);
          base.product = prod ? { name: prod.name } : null;
        }
        if (args.include?.user !== undefined) {
          const usr = state.users.find((u) => u.id === row.userId);
          base.user = usr ? { username: usr.username } : null;
        }
        return base;
      }),
    );
  }

  function inventoryMovementCountImpl(args: {
    where?: Readonly<Record<string, unknown>>;
  }): Promise<number> {
    return Promise.resolve(state.movements.filter((m) => matchesMovement(m, args.where)).length);
  }

  // Tx-shaped delegate map handed to `$transaction` callbacks. Mirrors
  // the surface the inventory service actually calls inside a
  // transaction: `inventory.{findUniqueOrThrow,update}` and
  // `inventoryMovement.create` for `applyMovement`, plus
  // `auditLog.create` and `journalEntry.create` for the public
  // `adjust` path (Req 13.3, 10.4).
  const tx = {
    inventory: {
      findUniqueOrThrow: inventoryFindUniqueOrThrowImpl,
      update: inventoryUpdateImpl,
    },
    inventoryMovement: {
      create: inventoryMovementCreateImpl,
    },
    auditLog: {
      create: auditLogCreateImpl,
    },
    journalEntry: {
      create: journalEntryCreateImpl,
    },
  };

  async function $transaction<T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> {
    // Snapshot state so a thrown exception inside the callback rolls
    // every write back — matching Prisma's real `$transaction`
    // semantics. This is what makes "OutOfStockError leaves no row"
    // and "audit/journal/movement all-or-nothing" observable.
    const snapshot = {
      inventories: state.inventories.map((i) => ({ ...i })),
      movements: state.movements.map((m) => ({ ...m })),
      auditLogs: state.auditLogs.map((a) => ({ ...a })),
      journalEntries: state.journalEntries.map((j) => ({ ...j })),
      nextMovementId: state.nextMovementId,
      nextAuditId: state.nextAuditId,
      nextJournalId: state.nextJournalId,
    };
    try {
      return await cb(tx);
    } catch (err) {
      state.inventories = snapshot.inventories;
      state.movements = snapshot.movements;
      state.auditLogs = snapshot.auditLogs;
      state.journalEntries = snapshot.journalEntries;
      state.nextMovementId = snapshot.nextMovementId;
      state.nextAuditId = snapshot.nextAuditId;
      state.nextJournalId = snapshot.nextJournalId;
      throw err;
    }
  }

  return {
    prisma: {
      inventory: {
        findUniqueOrThrow: inventoryFindUniqueOrThrowImpl,
        update: inventoryUpdateImpl,
      },
      inventoryMovement: {
        create: inventoryMovementCreateImpl,
        findMany: inventoryMovementFindManyImpl,
        count: inventoryMovementCountImpl,
      },
      auditLog: {
        create: auditLogCreateImpl,
      },
      journalEntry: {
        create: journalEntryCreateImpl,
      },
      $transaction,
      $queryRaw: queryRawImpl,
    },
  };
});

// Imports MUST come after `vi.mock`.
import { prisma } from '@main/db/prisma';
import {
  applyMovement,
  InventoryService,
  OutOfStockError,
} from '@main/services/inventory.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedInventory(productId: string, onHand: number): void {
  mockState.state.inventories.push({
    productId,
    onHand,
    updatedAt: new Date(),
  });
}

/**
 * Seed a `Product` row plus its `Inventory` row in lock-step. The
 * low-stock queries (Phase 5, task 5.3) join `Inventory` against
 * `Product.reorderLevel`, so the tests need both tables populated;
 * having one helper that inserts the pair keeps the surrounding
 * setup short.
 */
function seedProductWithInventory(opts: {
  productId: string;
  sku: string;
  name: string;
  onHand: number;
  reorderLevel: number;
}): void {
  mockState.state.products.push({
    id: opts.productId,
    sku: opts.sku,
    name: opts.name,
    reorderLevel: opts.reorderLevel,
  });
  mockState.state.inventories.push({
    productId: opts.productId,
    onHand: opts.onHand,
    updatedAt: new Date(),
  });
}

function getInventory(productId: string): { productId: string; onHand: number } | undefined {
  return mockState.state.inventories.find((i) => i.productId === productId);
}

beforeEach(() => {
  mockState.reset();
});

afterEach(() => {
  mockState.reset();
});

// ---------------------------------------------------------------------------
// Surface checks
// ---------------------------------------------------------------------------

describe('InventoryService surface', () => {
  it('exposes applyMovement on the service literal', () => {
    expect(InventoryService.applyMovement).toBe(applyMovement);
  });

  it('exposes adjust on the service literal', () => {
    expect(typeof InventoryService.adjust).toBe('function');
  });

  it('exposes lowStockCount on the service literal', () => {
    expect(typeof InventoryService.lowStockCount).toBe('function');
  });

  it('exposes lowStockList on the service literal', () => {
    expect(typeof InventoryService.lowStockList).toBe('function');
  });

  it('exposes listMovements on the service literal', () => {
    expect(typeof InventoryService.listMovements).toBe('function');
  });

  it('exposes countMovements on the service literal', () => {
    expect(typeof InventoryService.countMovements).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Increment path (delta > 0)
// ---------------------------------------------------------------------------

describe('applyMovement: increment path', () => {
  it('increments onHand and inserts exactly one movement when delta > 0', async () => {
    seedInventory('p-1', 5);

    const result = await prisma.$transaction((tx) =>
      applyMovement(tx, {
        productId: 'p-1',
        delta: 7,
        movementType: 'purchase',
        referenceType: 'purchase',
        referenceId: 'pur-1',
        userId: 'u-admin',
      }),
    );

    expect(result.inventory.onHand).toBe(12);
    expect(result.movement.quantityDelta).toBe(7);
    expect(getInventory('p-1')?.onHand).toBe(12);
    expect(mockState.state.movements).toHaveLength(1);
  });

  it('persists every movement field as supplied by the caller', async () => {
    seedInventory('p-1', 0);

    await prisma.$transaction((tx) =>
      applyMovement(tx, {
        productId: 'p-1',
        delta: 3,
        movementType: 'purchase',
        referenceType: 'purchase',
        referenceId: 'pur-42',
        userId: 'u-admin',
      }),
    );

    const movement = mockState.state.movements[0];
    expect(movement).toBeDefined();
    expect(movement!.productId).toBe('p-1');
    expect(movement!.quantityDelta).toBe(3);
    expect(movement!.movementType).toBe('purchase');
    expect(movement!.referenceType).toBe('purchase');
    expect(movement!.referenceId).toBe('pur-42');
    expect(movement!.userId).toBe('u-admin');
  });

  it('inserts exactly one movement per call (not two) on the increment path', async () => {
    seedInventory('p-1', 0);

    await prisma.$transaction((tx) =>
      applyMovement(tx, {
        productId: 'p-1',
        delta: 1,
        movementType: 'return',
        referenceType: 'sale',
        referenceId: 'sale-1',
        userId: 'u-cashier',
      }),
    );

    expect(mockState.state.movements).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Decrement path (delta < 0)
// ---------------------------------------------------------------------------

describe('applyMovement: decrement path', () => {
  it('decrements onHand and inserts exactly one movement when delta < 0', async () => {
    seedInventory('p-1', 10);

    const result = await prisma.$transaction((tx) =>
      applyMovement(tx, {
        productId: 'p-1',
        delta: -4,
        movementType: 'sale',
        referenceType: 'sale',
        referenceId: 'sale-1',
        userId: 'u-cashier',
      }),
    );

    expect(result.inventory.onHand).toBe(6);
    expect(result.movement.quantityDelta).toBe(-4);
    expect(getInventory('p-1')?.onHand).toBe(6);
    expect(mockState.state.movements).toHaveLength(1);
    expect(mockState.state.movements[0]!.movementType).toBe('sale');
  });

  it('drives onHand exactly to zero when delta == -onHand', async () => {
    seedInventory('p-1', 3);

    await prisma.$transaction((tx) =>
      applyMovement(tx, {
        productId: 'p-1',
        delta: -3,
        movementType: 'sale',
        referenceType: 'sale',
        referenceId: 'sale-2',
        userId: 'u-cashier',
      }),
    );

    expect(getInventory('p-1')?.onHand).toBe(0);
    expect(mockState.state.movements).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// OutOfStockError (Req 3.7)
// ---------------------------------------------------------------------------

describe('applyMovement: OutOfStockError', () => {
  it('throws OutOfStockError when delta would push onHand below zero', async () => {
    seedInventory('p-1', 2);

    await expect(
      prisma.$transaction((tx) =>
        applyMovement(tx, {
          productId: 'p-1',
          delta: -3,
          movementType: 'sale',
          referenceType: 'sale',
          referenceId: 'sale-1',
          userId: 'u-cashier',
        }),
      ),
    ).rejects.toBeInstanceOf(OutOfStockError);
  });

  it('attaches the offending productId to the thrown error', async () => {
    seedInventory('p-target', 0);

    await expect(
      prisma.$transaction((tx) =>
        applyMovement(tx, {
          productId: 'p-target',
          delta: -1,
          movementType: 'sale',
          referenceType: 'sale',
          referenceId: 'sale-1',
          userId: 'u-cashier',
        }),
      ),
    ).rejects.toMatchObject({
      name: 'OutOfStockError',
      productId: 'p-target',
    });
  });

  it('leaves the inventory row untouched when the pre-check fails', async () => {
    seedInventory('p-1', 1);

    await expect(
      prisma.$transaction((tx) =>
        applyMovement(tx, {
          productId: 'p-1',
          delta: -2,
          movementType: 'sale',
          referenceType: 'sale',
          referenceId: 'sale-1',
          userId: 'u-cashier',
        }),
      ),
    ).rejects.toBeInstanceOf(OutOfStockError);

    expect(getInventory('p-1')?.onHand).toBe(1);
  });

  it('writes no movement row when the pre-check fails', async () => {
    seedInventory('p-1', 0);

    await expect(
      prisma.$transaction((tx) =>
        applyMovement(tx, {
          productId: 'p-1',
          delta: -5,
          movementType: 'sale',
          referenceType: 'sale',
          referenceId: 'sale-1',
          userId: 'u-cashier',
        }),
      ),
    ).rejects.toBeInstanceOf(OutOfStockError);

    expect(mockState.state.movements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-product isolation
// ---------------------------------------------------------------------------

describe('applyMovement: cross-product isolation', () => {
  it('does not touch other products inventory rows', async () => {
    seedInventory('p-target', 5);
    seedInventory('p-other-1', 10);
    seedInventory('p-other-2', 0);

    await prisma.$transaction((tx) =>
      applyMovement(tx, {
        productId: 'p-target',
        delta: -2,
        movementType: 'sale',
        referenceType: 'sale',
        referenceId: 'sale-1',
        userId: 'u-cashier',
      }),
    );

    expect(getInventory('p-target')?.onHand).toBe(3);
    expect(getInventory('p-other-1')?.onHand).toBe(10);
    expect(getInventory('p-other-2')?.onHand).toBe(0);
  });

  it('writes a movement row only for the targeted product', async () => {
    seedInventory('p-target', 5);
    seedInventory('p-other', 5);

    await prisma.$transaction((tx) =>
      applyMovement(tx, {
        productId: 'p-target',
        delta: 3,
        movementType: 'purchase',
        referenceType: 'purchase',
        referenceId: 'pur-1',
        userId: 'u-admin',
      }),
    );

    expect(mockState.state.movements).toHaveLength(1);
    expect(mockState.state.movements[0]!.productId).toBe('p-target');
  });
});

// ---------------------------------------------------------------------------
// Ledger invariant (per-call)
// ---------------------------------------------------------------------------

describe('applyMovement: ledger invariant', () => {
  it('keeps onHand == sum(quantityDelta) across multiple sequential calls', async () => {
    seedInventory('p-1', 0);

    const deltas = [+10, -3, +5, -2, +7, -1];
    for (const delta of deltas) {
      await prisma.$transaction((tx) =>
        applyMovement(tx, {
          productId: 'p-1',
          delta,
          movementType: delta >= 0 ? 'purchase' : 'sale',
          referenceType: delta >= 0 ? 'purchase' : 'sale',
          referenceId: `ref-${delta}`,
          userId: 'u-admin',
        }),
      );
    }

    const expectedOnHand = deltas.reduce((acc, d) => acc + d, 0);
    expect(getInventory('p-1')?.onHand).toBe(expectedOnHand);

    const sumOfMovements = mockState.state.movements
      .filter((m) => m.productId === 'p-1')
      .reduce((acc, m) => acc + m.quantityDelta, 0);
    expect(sumOfMovements).toBe(expectedOnHand);
  });
});


// ---------------------------------------------------------------------------
// adjust — happy path (Req 3.5, 13.3)
// ---------------------------------------------------------------------------

describe('InventoryService.adjust: happy path', () => {
  it('increments onHand, writes one movement + one audit + one journal row, returns Ok({ movementId })', async () => {
    seedInventory('p-1', 10);

    const result = await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 4, reason: 'Recount: extra unit found' },
      { userId: 'u-admin' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value.movementId).toBe('string');
    expect(result.value.movementId.length).toBeGreaterThan(0);

    expect(getInventory('p-1')?.onHand).toBe(14);
    expect(mockState.state.movements).toHaveLength(1);
    expect(mockState.state.auditLogs).toHaveLength(1);
    expect(mockState.state.journalEntries).toHaveLength(1);

    const movement = mockState.state.movements[0]!;
    expect(movement.id).toBe(result.value.movementId);
    expect(movement.productId).toBe('p-1');
    expect(movement.quantityDelta).toBe(4);
    expect(movement.movementType).toBe('adjustment');
    expect(movement.referenceType).toBe('adjustment');
    expect(movement.userId).toBe('u-admin');
    // referenceId is the generated adjustmentId; it MUST equal the
    // adjustmentId embedded in the audit + journal payloads (cross-row
    // correlation).
    expect(typeof movement.referenceId).toBe('string');
    expect(movement.referenceId.length).toBeGreaterThan(0);
  });

  it('decrements onHand on a negative delta', async () => {
    seedInventory('p-1', 10);

    const result = await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: -3, reason: 'Damaged in transit' },
      { userId: 'u-admin' },
    );

    expect(result.ok).toBe(true);
    expect(getInventory('p-1')?.onHand).toBe(7);
    expect(mockState.state.movements[0]?.quantityDelta).toBe(-3);
  });

  it('writes the audit log with actionType "stock.adjust", entityType "product", and a previous/next snapshot', async () => {
    seedInventory('p-1', 5);

    await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 2, reason: 'Cycle count' },
      { userId: 'u-admin-42' },
    );

    const audit = mockState.state.auditLogs[0]!;
    expect(audit.actionType).toBe('stock.adjust');
    expect(audit.entityType).toBe('product');
    expect(audit.entityId).toBe('p-1');
    expect(audit.userId).toBe('u-admin-42');

    const previous = JSON.parse(audit.previous!) as { onHand: number };
    expect(previous.onHand).toBe(5);

    const next = JSON.parse(audit.next!) as {
      adjustmentId: string;
      quantityDelta: number;
      reason: string;
      onHand: number;
    };
    expect(next.quantityDelta).toBe(2);
    expect(next.reason).toBe('Cycle count');
    expect(next.onHand).toBe(7);
    expect(typeof next.adjustmentId).toBe('string');
    expect(next.adjustmentId.length).toBeGreaterThan(0);
  });

  it('writes a journal entry with opType "adjustment" carrying productId, delta, reason, userId', async () => {
    seedInventory('p-1', 0);

    await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 7, reason: 'Initial stock load' },
      { userId: 'u-admin' },
    );

    const journal = mockState.state.journalEntries[0]!;
    expect(journal.opType).toBe('adjustment');

    const payload = JSON.parse(journal.payload) as {
      adjustmentId: string;
      productId: string;
      quantityDelta: number;
      reason: string;
      userId: string;
      timestamp: string;
    };
    expect(payload.productId).toBe('p-1');
    expect(payload.quantityDelta).toBe(7);
    expect(payload.reason).toBe('Initial stock load');
    expect(payload.userId).toBe('u-admin');
    expect(typeof payload.adjustmentId).toBe('string');
    expect(typeof payload.timestamp).toBe('string');
    expect(Number.isFinite(Date.parse(payload.timestamp))).toBe(true);
  });

  it('uses the same adjustmentId across the movement, audit, and journal rows (cross-row correlation)', async () => {
    seedInventory('p-1', 0);

    await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 1, reason: 'Found one' },
      { userId: 'u-admin' },
    );

    const movementRefId = mockState.state.movements[0]!.referenceId;
    const auditNext = JSON.parse(mockState.state.auditLogs[0]!.next!) as { adjustmentId: string };
    const journalPayload = JSON.parse(mockState.state.journalEntries[0]!.payload) as {
      adjustmentId: string;
    };

    expect(auditNext.adjustmentId).toBe(movementRefId);
    expect(journalPayload.adjustmentId).toBe(movementRefId);
  });

  it('trims whitespace from the reason text before persisting', async () => {
    seedInventory('p-1', 0);

    await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 1, reason: '   trim me   ' },
      { userId: 'u-admin' },
    );

    const auditNext = JSON.parse(mockState.state.auditLogs[0]!.next!) as { reason: string };
    expect(auditNext.reason).toBe('trim me');
  });
});

// ---------------------------------------------------------------------------
// adjust — out-of-stock (Req 3.7)
// ---------------------------------------------------------------------------

describe('InventoryService.adjust: OUT_OF_STOCK', () => {
  it('returns Err("OUT_OF_STOCK", { productId }) when delta would push onHand below zero', async () => {
    seedInventory('p-1', 2);

    const result = await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: -3, reason: 'Trying to break things' },
      { userId: 'u-admin' },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('OUT_OF_STOCK');
    expect(result.error.details).toEqual({ productId: 'p-1' });
  });

  it('writes nothing (no movement, no audit, no journal) and leaves onHand untouched', async () => {
    seedInventory('p-1', 1);

    const result = await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: -5, reason: 'Big mistake' },
      { userId: 'u-admin' },
    );

    expect(result.ok).toBe(false);
    expect(getInventory('p-1')?.onHand).toBe(1);
    expect(mockState.state.movements).toHaveLength(0);
    expect(mockState.state.auditLogs).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// adjust — FK violation (unknown product)
// ---------------------------------------------------------------------------

describe('InventoryService.adjust: unknown product', () => {
  it('returns Err("FK_VIOLATION", { reason: "not_found" }) when no inventory row exists for productId', async () => {
    // Note: no seedInventory() call.
    const result = await InventoryService.adjust(
      { productId: 'p-missing', quantityDelta: 1, reason: 'Phantom product' },
      { userId: 'u-admin' },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FK_VIOLATION');
    expect(result.error.details).toEqual({ reason: 'not_found' });
  });

  it('writes nothing on the unknown-product path', async () => {
    await InventoryService.adjust(
      { productId: 'p-missing', quantityDelta: 1, reason: 'Phantom' },
      { userId: 'u-admin' },
    );

    expect(mockState.state.movements).toHaveLength(0);
    expect(mockState.state.auditLogs).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// adjust — input validation (Req 3.5)
// ---------------------------------------------------------------------------

describe('InventoryService.adjust: input validation', () => {
  it('rejects an empty productId with VALIDATION', async () => {
    const result = await InventoryService.adjust(
      { productId: '', quantityDelta: 1, reason: 'reason' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details).toEqual({ field: 'productId' });
  });

  it('rejects a zero delta with VALIDATION (zero adjustments have no business semantics)', async () => {
    seedInventory('p-1', 5);
    const result = await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 0, reason: 'noop' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details).toEqual({ field: 'quantityDelta' });
  });

  it('rejects a non-integer delta with VALIDATION', async () => {
    seedInventory('p-1', 5);
    const result = await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 1.5, reason: 'fractional' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details).toEqual({ field: 'quantityDelta' });
  });

  it('rejects a non-finite delta with VALIDATION', async () => {
    seedInventory('p-1', 5);
    const result = await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: Number.POSITIVE_INFINITY, reason: 'inf' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details).toEqual({ field: 'quantityDelta' });
  });

  it('rejects an empty reason (after trim) with VALIDATION', async () => {
    seedInventory('p-1', 5);
    const result = await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 1, reason: '   ' },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details).toEqual({ field: 'reason' });
  });

  it('rejects a reason longer than 200 characters with VALIDATION', async () => {
    seedInventory('p-1', 5);
    const longReason = 'x'.repeat(201);
    const result = await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 1, reason: longReason },
      { userId: 'u-admin' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details).toEqual({ field: 'reason' });
  });

  it('writes nothing on a validation rejection', async () => {
    seedInventory('p-1', 5);
    await InventoryService.adjust(
      { productId: 'p-1', quantityDelta: 0, reason: 'noop' },
      { userId: 'u-admin' },
    );
    expect(getInventory('p-1')?.onHand).toBe(5);
    expect(mockState.state.movements).toHaveLength(0);
    expect(mockState.state.auditLogs).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// lowStockCount (Phase 5, task 5.3) — Req 3.6
// ---------------------------------------------------------------------------

describe('InventoryService.lowStockCount', () => {
  it('returns Ok({ count: 0 }) when no products exist', async () => {
    const result = await InventoryService.lowStockCount();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ count: 0 });
  });

  it('returns Ok({ count: 0 }) when every product is above its reorder level', async () => {
    seedProductWithInventory({ productId: 'p-1', sku: 'A', name: 'Apples', onHand: 10, reorderLevel: 5 });
    seedProductWithInventory({ productId: 'p-2', sku: 'B', name: 'Bananas', onHand: 7, reorderLevel: 3 });

    const result = await InventoryService.lowStockCount();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(0);
  });

  it('counts products whose onHand is at or below reorder level (boundary inclusive)', async () => {
    // p-1 above (not counted), p-2 exactly at reorder level (counted),
    // p-3 below (counted), p-4 at zero with reorderLevel=0 (counted).
    seedProductWithInventory({ productId: 'p-1', sku: 'A', name: 'A', onHand: 10, reorderLevel: 5 });
    seedProductWithInventory({ productId: 'p-2', sku: 'B', name: 'B', onHand: 5, reorderLevel: 5 });
    seedProductWithInventory({ productId: 'p-3', sku: 'C', name: 'C', onHand: 1, reorderLevel: 5 });
    seedProductWithInventory({ productId: 'p-4', sku: 'D', name: 'D', onHand: 0, reorderLevel: 0 });

    const result = await InventoryService.lowStockCount();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(3);
  });

  it('counts every below-or-at-threshold product when all are low', async () => {
    seedProductWithInventory({ productId: 'p-1', sku: 'A', name: 'A', onHand: 0, reorderLevel: 5 });
    seedProductWithInventory({ productId: 'p-2', sku: 'B', name: 'B', onHand: 2, reorderLevel: 5 });
    seedProductWithInventory({ productId: 'p-3', sku: 'C', name: 'C', onHand: 5, reorderLevel: 5 });

    const result = await InventoryService.lowStockCount();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// lowStockList (Phase 5, task 5.3) — Req 3.6, 9.3
// ---------------------------------------------------------------------------

describe('InventoryService.lowStockList', () => {
  it('returns Ok({ rows: [] }) when no products exist', async () => {
    const result = await InventoryService.lowStockList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([]);
  });

  it('returns Ok({ rows: [] }) when every product is above its reorder level', async () => {
    seedProductWithInventory({ productId: 'p-1', sku: 'A', name: 'A', onHand: 10, reorderLevel: 5 });
    seedProductWithInventory({ productId: 'p-2', sku: 'B', name: 'B', onHand: 7, reorderLevel: 3 });

    const result = await InventoryService.lowStockList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([]);
  });

  it('returns rows for products at or below their reorder level (boundary inclusive)', async () => {
    seedProductWithInventory({ productId: 'p-above', sku: 'AB', name: 'Above', onHand: 10, reorderLevel: 5 });
    seedProductWithInventory({ productId: 'p-at',    sku: 'AT', name: 'At',    onHand: 5,  reorderLevel: 5 });
    seedProductWithInventory({ productId: 'p-below', sku: 'BL', name: 'Below', onHand: 1,  reorderLevel: 5 });

    const result = await InventoryService.lowStockList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.productId);
    expect(ids).toContain('p-at');
    expect(ids).toContain('p-below');
    expect(ids).not.toContain('p-above');
  });

  it('projects every wire column (productId, sku, name, onHand, reorderLevel)', async () => {
    seedProductWithInventory({
      productId: 'p-1',
      sku: 'SKU-1',
      name: 'Widget',
      onHand: 2,
      reorderLevel: 5,
    });

    const result = await InventoryService.lowStockList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.rows).toHaveLength(1);
    const row = result.value.rows[0]!;
    expect(row).toEqual({
      productId: 'p-1',
      sku: 'SKU-1',
      name: 'Widget',
      onHand: 2,
      reorderLevel: 5,
    });
  });

  it('orders rows most-urgent first (reorderLevel DESC, then onHand ASC, then name ASC)', async () => {
    // Higher reorderLevel comes first; on equal reorderLevel, lower
    // onHand comes first; on equal pairs, name asc.
    seedProductWithInventory({ productId: 'p-low-rl',  sku: 'L1', name: 'LowReorder', onHand: 0, reorderLevel: 1 });
    seedProductWithInventory({ productId: 'p-high-2',  sku: 'H2', name: 'Beta',       onHand: 3, reorderLevel: 10 });
    seedProductWithInventory({ productId: 'p-high-1',  sku: 'H1', name: 'Alpha',      onHand: 1, reorderLevel: 10 });
    seedProductWithInventory({ productId: 'p-high-3',  sku: 'H3', name: 'Charlie',    onHand: 1, reorderLevel: 10 });
    seedProductWithInventory({ productId: 'p-mid-rl',  sku: 'M1', name: 'MidReorder', onHand: 1, reorderLevel: 5 });

    const result = await InventoryService.lowStockList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.productId);
    // Order: reorderLevel 10 group first.
    //   p-high-1 (onHand 1, name Alpha) before p-high-3 (onHand 1, name Charlie) before p-high-2 (onHand 3, Beta).
    // Then reorderLevel 5: p-mid-rl.
    // Then reorderLevel 1: p-low-rl.
    expect(ids).toEqual(['p-high-1', 'p-high-3', 'p-high-2', 'p-mid-rl', 'p-low-rl']);
  });

  it('returns row.onHand and row.reorderLevel as plain JS numbers (not BigInt)', async () => {
    seedProductWithInventory({ productId: 'p-1', sku: 'A', name: 'A', onHand: 0, reorderLevel: 5 });

    const result = await InventoryService.lowStockList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.value.rows[0]!;
    expect(typeof row.onHand).toBe('number');
    expect(typeof row.reorderLevel).toBe('number');
  });

  it('skips inventories whose product row is missing (orphaned cache row)', async () => {
    // No matching Product row for p-orphan; the join filters it out.
    seedInventory('p-orphan', 0);
    seedProductWithInventory({ productId: 'p-real', sku: 'R', name: 'Real', onHand: 0, reorderLevel: 5 });

    const result = await InventoryService.lowStockList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.productId)).toEqual(['p-real']);
  });
});

// ---------------------------------------------------------------------------
// listMovements / countMovements (Phase 5, task 5.5.1) — Req 3.1, 16.1–16.4
// ---------------------------------------------------------------------------

/**
 * Seed a `User` row that the movement-list join can project into
 * `userName`. Keeping the helper small and explicit keeps the
 * test setup readable; tests that don't need the join (e.g. they
 * assert the count only) skip the seeding.
 */
function seedUser(userId: string, username: string): void {
  mockState.state.users.push({ id: userId, username });
}

/**
 * Seed a product row used by the movement-list `Product.name` join.
 * Mirrors the `Product` columns the inventory service actually
 * touches (`id`, `sku`, `name`, `reorderLevel`); other columns are
 * unused so we don't bother.
 */
function seedProductRow(productId: string, name: string, sku = `sku-${productId}`): void {
  mockState.state.products.push({
    id: productId,
    sku,
    name,
    reorderLevel: 0,
  });
}

/**
 * Seed a fully-formed `InventoryMovement` row. Tests pass an explicit
 * `timestamp` so cursor walks across the page boundary are
 * deterministic; defaults are filled in for fields the test does not
 * care about.
 */
function seedMovement(opts: {
  id: string;
  productId: string;
  quantityDelta: number;
  movementType?: string;
  referenceType?: string;
  referenceId?: string;
  userId?: string;
  timestamp: Date;
}): void {
  mockState.state.movements.push({
    id: opts.id,
    productId: opts.productId,
    quantityDelta: opts.quantityDelta,
    movementType: opts.movementType ?? 'sale',
    referenceType: opts.referenceType ?? 'sale',
    referenceId: opts.referenceId ?? `ref-${opts.id}`,
    userId: opts.userId ?? 'u-admin',
    timestamp: opts.timestamp,
  });
}

describe('InventoryService.listMovements: empty result', () => {
  it('returns Ok({ rows: [], nextCursor: null }) when no movements exist', async () => {
    const result = await InventoryService.listMovements({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toEqual([]);
    expect(result.value.nextCursor).toBeNull();
    expect('totalCount' in result.value).toBe(false);
  });

  it('omits totalCount when withCount is unset', async () => {
    const result = await InventoryService.listMovements({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('totalCount' in result.value).toBe(false);
  });

  it('includes totalCount: 0 when withCount is true', async () => {
    const result = await InventoryService.listMovements({ withCount: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCount).toBe(0);
  });
});

describe('InventoryService.listMovements: ordering and DTO mapping', () => {
  it('orders rows by (timestamp DESC, id DESC) and projects joined product/user names', async () => {
    seedProductRow('p-1', 'Widget');
    seedUser('u-admin', 'admin');

    seedMovement({
      id: 'mov-old',
      productId: 'p-1',
      quantityDelta: 1,
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-mid',
      productId: 'p-1',
      quantityDelta: 2,
      timestamp: new Date('2024-06-01T00:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-new',
      productId: 'p-1',
      quantityDelta: 3,
      timestamp: new Date('2024-12-01T00:00:00.000Z'),
    });

    const result = await InventoryService.listMovements({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.rows.map((r) => r.id);
    expect(ids).toEqual(['mov-new', 'mov-mid', 'mov-old']);

    const newest = result.value.rows[0]!;
    expect(newest.productId).toBe('p-1');
    expect(newest.productName).toBe('Widget');
    expect(newest.userId).toBe('u-admin');
    expect(newest.userName).toBe('admin');
    expect(newest.quantityDelta).toBe(3);
    // Timestamp must serialize as ISO 8601 string (DTO contract).
    expect(typeof newest.timestamp).toBe('string');
    expect(Number.isFinite(Date.parse(newest.timestamp))).toBe(true);
  });

  it('breaks ties on identical timestamps by id DESC', async () => {
    seedProductRow('p-1', 'Widget');
    seedUser('u-admin', 'admin');
    const ts = new Date('2024-06-01T00:00:00.000Z');
    seedMovement({ id: 'mov-a', productId: 'p-1', quantityDelta: 1, timestamp: ts });
    seedMovement({ id: 'mov-b', productId: 'p-1', quantityDelta: 1, timestamp: ts });
    seedMovement({ id: 'mov-c', productId: 'p-1', quantityDelta: 1, timestamp: ts });

    const result = await InventoryService.listMovements({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.id)).toEqual(['mov-c', 'mov-b', 'mov-a']);
  });
});

describe('InventoryService.listMovements: filters', () => {
  beforeEach(() => {
    seedProductRow('p-1', 'Widget');
    seedProductRow('p-2', 'Gadget');
    seedUser('u-admin', 'admin');

    seedMovement({
      id: 'mov-1',
      productId: 'p-1',
      quantityDelta: -1,
      movementType: 'sale',
      timestamp: new Date('2024-03-15T10:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-2',
      productId: 'p-1',
      quantityDelta: 5,
      movementType: 'purchase',
      timestamp: new Date('2024-04-15T10:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-3',
      productId: 'p-2',
      quantityDelta: -2,
      movementType: 'sale',
      timestamp: new Date('2024-05-15T10:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-4',
      productId: 'p-2',
      quantityDelta: 3,
      movementType: 'adjustment',
      timestamp: new Date('2024-06-15T10:00:00.000Z'),
    });
  });

  it('filters by productId', async () => {
    const result = await InventoryService.listMovements({
      filter: { productId: 'p-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.id).sort()).toEqual(['mov-1', 'mov-2']);
  });

  it('filters by movementType', async () => {
    const result = await InventoryService.listMovements({
      filter: { movementType: 'sale' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.id).sort()).toEqual(['mov-1', 'mov-3']);
  });

  it('filters by combined productId + movementType', async () => {
    const result = await InventoryService.listMovements({
      filter: { productId: 'p-1', movementType: 'purchase' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.id)).toEqual(['mov-2']);
  });

  it('filters by inclusive [dateFrom, dateTo] window', async () => {
    const result = await InventoryService.listMovements({
      filter: {
        dateFrom: '2024-04-01T00:00:00.000Z',
        dateTo: '2024-05-31T23:59:59.999Z',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // mov-2 (Apr 15) and mov-3 (May 15) are inside the window;
    // mov-1 (Mar 15) and mov-4 (Jun 15) are outside.
    expect(result.value.rows.map((r) => r.id).sort()).toEqual(['mov-2', 'mov-3']);
  });

  it('filters by dateFrom alone (open-ended upper bound)', async () => {
    const result = await InventoryService.listMovements({
      filter: { dateFrom: '2024-05-01T00:00:00.000Z' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.id).sort()).toEqual(['mov-3', 'mov-4']);
  });

  it('filters by dateTo alone (open-ended lower bound)', async () => {
    const result = await InventoryService.listMovements({
      filter: { dateTo: '2024-04-30T23:59:59.999Z' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.id).sort()).toEqual(['mov-1', 'mov-2']);
  });
});

describe('InventoryService.listMovements: cursor pagination', () => {
  it('paginates across pages with the cursor and stops with nextCursor: null on the final page', async () => {
    seedProductRow('p-1', 'Widget');
    seedUser('u-admin', 'admin');
    // 5 rows across distinct timestamps.
    for (let i = 0; i < 5; i++) {
      seedMovement({
        id: `mov-${i}`,
        productId: 'p-1',
        quantityDelta: 1,
        timestamp: new Date(Date.UTC(2024, 0, i + 1)),
      });
    }

    const first = await InventoryService.listMovements({ pageSize: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.rows.map((r) => r.id)).toEqual(['mov-4', 'mov-3']);
    expect(typeof first.value.nextCursor).toBe('string');

    const second = await InventoryService.listMovements({
      pageSize: 2,
      cursor: first.value.nextCursor!,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.rows.map((r) => r.id)).toEqual(['mov-2', 'mov-1']);
    expect(typeof second.value.nextCursor).toBe('string');

    const third = await InventoryService.listMovements({
      pageSize: 2,
      cursor: second.value.nextCursor!,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.rows.map((r) => r.id)).toEqual(['mov-0']);
    expect(third.value.nextCursor).toBeNull();
  });

  it('returns Err(VALIDATION, { field: "cursor" }) for a malformed cursor token', async () => {
    seedProductRow('p-1', 'Widget');
    seedUser('u-admin', 'admin');
    seedMovement({
      id: 'mov-1',
      productId: 'p-1',
      quantityDelta: 1,
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
    });

    const result = await InventoryService.listMovements({ cursor: '!!!not-base64!!!' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.details).toEqual({ field: 'cursor' });
  });

  it('clamps page sizes above 200 to 200', async () => {
    seedProductRow('p-1', 'Widget');
    seedUser('u-admin', 'admin');
    // Seed 250 rows.
    for (let i = 0; i < 250; i++) {
      seedMovement({
        id: `mov-${String(i).padStart(3, '0')}`,
        productId: 'p-1',
        quantityDelta: 1,
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, i)),
      });
    }
    const result = await InventoryService.listMovements({ pageSize: 1_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(200);
  });
});

describe('InventoryService.listMovements: withCount opt-in', () => {
  it('returns totalCount that ignores the cursor predicate', async () => {
    seedProductRow('p-1', 'Widget');
    seedUser('u-admin', 'admin');
    for (let i = 0; i < 5; i++) {
      seedMovement({
        id: `mov-${i}`,
        productId: 'p-1',
        quantityDelta: 1,
        timestamp: new Date(Date.UTC(2024, 0, i + 1)),
      });
    }

    const first = await InventoryService.listMovements({ pageSize: 2, withCount: true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.totalCount).toBe(5);

    // The total stays stable across pages.
    const second = await InventoryService.listMovements({
      pageSize: 2,
      cursor: first.value.nextCursor!,
      withCount: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.totalCount).toBe(5);
  });

  it('counts the same set the filter selects', async () => {
    seedProductRow('p-1', 'Widget');
    seedProductRow('p-2', 'Gadget');
    seedUser('u-admin', 'admin');
    seedMovement({
      id: 'mov-a',
      productId: 'p-1',
      quantityDelta: 1,
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-b',
      productId: 'p-2',
      quantityDelta: 1,
      timestamp: new Date('2024-01-02T00:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-c',
      productId: 'p-1',
      quantityDelta: 1,
      timestamp: new Date('2024-01-03T00:00:00.000Z'),
    });

    const result = await InventoryService.listMovements({
      filter: { productId: 'p-1' },
      withCount: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCount).toBe(2);
  });
});

describe('InventoryService.countMovements', () => {
  it('returns Ok({ totalCount: 0 }) when no movements exist', async () => {
    const result = await InventoryService.countMovements({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ totalCount: 0 });
  });

  it('counts every row when no filter is supplied', async () => {
    seedMovement({
      id: 'mov-1',
      productId: 'p-1',
      quantityDelta: 1,
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-2',
      productId: 'p-2',
      quantityDelta: 1,
      timestamp: new Date('2024-01-02T00:00:00.000Z'),
    });

    const result = await InventoryService.countMovements({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCount).toBe(2);
  });

  it('counts rows matching a productId filter only', async () => {
    seedMovement({
      id: 'mov-1',
      productId: 'p-1',
      quantityDelta: 1,
      timestamp: new Date('2024-01-01T00:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-2',
      productId: 'p-2',
      quantityDelta: 1,
      timestamp: new Date('2024-01-02T00:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-3',
      productId: 'p-1',
      quantityDelta: 1,
      timestamp: new Date('2024-01-03T00:00:00.000Z'),
    });

    const result = await InventoryService.countMovements({
      filter: { productId: 'p-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCount).toBe(2);
  });

  it('counts rows matching a movementType + date range filter', async () => {
    seedMovement({
      id: 'mov-1',
      productId: 'p-1',
      quantityDelta: -1,
      movementType: 'sale',
      timestamp: new Date('2024-03-15T00:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-2',
      productId: 'p-1',
      quantityDelta: 1,
      movementType: 'purchase',
      timestamp: new Date('2024-04-15T00:00:00.000Z'),
    });
    seedMovement({
      id: 'mov-3',
      productId: 'p-2',
      quantityDelta: -1,
      movementType: 'sale',
      timestamp: new Date('2024-05-15T00:00:00.000Z'),
    });

    const result = await InventoryService.countMovements({
      filter: {
        movementType: 'sale',
        dateFrom: '2024-04-01T00:00:00.000Z',
        dateTo: '2024-05-31T23:59:59.999Z',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCount).toBe(1);
  });
});
