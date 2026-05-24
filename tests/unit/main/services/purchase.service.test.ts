import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `PurchaseService` (Phase 6, task 6.2).
 *
 * Drives the service against an in-memory mock of the Prisma
 * delegates each path touches inside its `$transaction`:
 *   - `create`: `purchase.create` (header), `purchaseItem.create`
 *     (one row per line), `inventory.findUniqueOrThrow` +
 *     `inventory.update` + `inventoryMovement.create` (driven by
 *     `applyMovement`), and `journalEntry.create` (one row).
 *   - `list` / `count`: `purchase.findMany` + `purchase.count` with
 *     the supplier join + `_count` of items attached.
 *
 * The shared `$transaction` wrapper hands the service a tx-shaped
 * delegate map and snapshots/rolls-back state on a thrown exception
 * so tests can observe the all-or-nothing semantics of `create` —
 * one Prisma error rolls back the header, items, ledger movements,
 * AND the journal row.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 11.2, 16.1, 16.2,
 *            16.3, 16.4.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockPurchase {
    id: string;
    supplierId: string;
    invoiceNo: string | null;
    total: string;
    createdAt: Date;
  }
  interface MockPurchaseItem {
    id: string;
    purchaseId: string;
    productId: string;
    quantity: number;
    unitBuyPrice: string;
    lineTotal: string;
  }
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
  interface MockJournalEntry {
    id: string;
    opType: string;
    payload: string;
    timestamp: Date;
  }
  interface MockSupplier {
    id: string;
    name: string;
  }

  const state = {
    purchases: [] as MockPurchase[],
    purchaseItems: [] as MockPurchaseItem[],
    inventories: [] as MockInventory[],
    movements: [] as MockMovement[],
    journalEntries: [] as MockJournalEntry[],
    suppliers: [] as MockSupplier[],
    nextPurchaseId: 0,
    nextPurchaseItemId: 0,
    nextMovementId: 0,
    nextJournalId: 0,
    /** When set, the next `purchase.create` invocation throws this
     *  Prisma error to simulate a constraint violation. Cleared
     *  after the throw. Used by the FK_VIOLATION mapping tests. */
    nextPurchaseCreateError: null as { code: string } | null,
    /** When set, the next `inventory.findUniqueOrThrow` invocation
     *  throws this error — drives the P2025 mapping test that mimics
     *  `applyMovement` failing because the product's inventory row is
     *  missing. */
    nextInventoryFindError: null as { code: string } | null,
  };

  return {
    state,
    reset(): void {
      state.purchases = [];
      state.purchaseItems = [];
      state.inventories = [];
      state.movements = [];
      state.journalEntries = [];
      state.suppliers = [];
      state.nextPurchaseId = 0;
      state.nextPurchaseItemId = 0;
      state.nextMovementId = 0;
      state.nextJournalId = 0;
      state.nextPurchaseCreateError = null;
      state.nextInventoryFindError = null;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  type MockPurchase = (typeof state.purchases)[number];
  type MockPurchaseItem = (typeof state.purchaseItems)[number];
  type MockInventory = (typeof state.inventories)[number];
  type MockMovement = (typeof state.movements)[number];
  type MockJournalEntry = (typeof state.journalEntries)[number];

  function makeKnownError(code: string, message: string): unknown {
    return new Prisma.PrismaClientKnownRequestError(message, {
      code,
      clientVersion: 'test',
    });
  }

  // ---- where matcher (subset of Prisma WhereInput) ----------------------
  function matches(
    row: Record<string, unknown>,
    where: Readonly<Record<string, unknown>> | undefined,
  ): boolean {
    if (where === undefined || Object.keys(where).length === 0) return true;
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
      const fieldValue = row[key];
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
        throw new Error(`unsupported comparator op in purchase mock: ${op}`);
    }
  }

  function compareRows(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    orderBy: readonly Readonly<Record<string, 'asc' | 'desc'>>[],
  ): number {
    for (const clause of orderBy) {
      for (const [key, dir] of Object.entries(clause)) {
        const av = a[key];
        const bv = b[key];
        const an = av instanceof Date ? av.getTime() : av;
        const bn = bv instanceof Date ? bv.getTime() : bv;
        if ((an as never) < (bn as never)) return dir === 'asc' ? -1 : 1;
        if ((an as never) > (bn as never)) return dir === 'asc' ? 1 : -1;
      }
    }
    return 0;
  }

  // ---- Purchase delegate -----------------------------------------------
  function purchaseCreate({
    data,
  }: {
    data: {
      supplier: { connect: { id: string } };
      total: { toString(): string };
      invoiceNo?: string;
    };
  }): Promise<MockPurchase> {
    if (state.nextPurchaseCreateError !== null) {
      const errSpec = state.nextPurchaseCreateError;
      state.nextPurchaseCreateError = null;
      throw makeKnownError(errSpec.code, 'purchase.create simulated error');
    }
    const row: MockPurchase = {
      id: `pur-${state.nextPurchaseId++}`,
      supplierId: data.supplier.connect.id,
      invoiceNo: data.invoiceNo ?? null,
      total: data.total.toString(),
      createdAt: new Date(`2024-01-01T0${state.nextPurchaseId}:00:00Z`),
    };
    state.purchases.push(row);
    return Promise.resolve({ ...row });
  }

  function purchaseFindMany(args: {
    where?: Readonly<Record<string, unknown>>;
    orderBy?: readonly Readonly<Record<string, 'asc' | 'desc'>>[];
    take?: number;
    include?: { supplier?: unknown; _count?: unknown };
  }): Promise<unknown[]> {
    let rows = state.purchases.filter((r) => matches(r as Record<string, unknown>, args.where));
    if (args.orderBy && args.orderBy.length > 0) {
      rows = [...rows].sort((a, b) =>
        compareRows(a as Record<string, unknown>, b as Record<string, unknown>, args.orderBy!),
      );
    }
    if (typeof args.take === 'number') rows = rows.slice(0, args.take);
    return Promise.resolve(
      rows.map((r) => {
        const out: Record<string, unknown> = {
          id: r.id,
          supplierId: r.supplierId,
          invoiceNo: r.invoiceNo,
          total: new Prisma.Decimal(r.total),
          createdAt: r.createdAt,
        };
        if (args.include?.supplier !== undefined) {
          const s = state.suppliers.find((sup) => sup.id === r.supplierId);
          out.supplier = s ? { name: s.name } : { name: 'Unknown' };
        }
        if (args.include?._count !== undefined) {
          out._count = {
            items: state.purchaseItems.filter((it) => it.purchaseId === r.id).length,
          };
        }
        return out;
      }),
    );
  }

  function purchaseCount({
    where,
  }: {
    where?: Readonly<Record<string, unknown>>;
  }): Promise<number> {
    return Promise.resolve(
      state.purchases.filter((r) => matches(r as Record<string, unknown>, where)).length,
    );
  }

  // ---- PurchaseItem delegate -------------------------------------------
  function purchaseItemCreate({
    data,
  }: {
    data: {
      purchaseId: string;
      productId: string;
      quantity: number;
      unitBuyPrice: { toString(): string };
      lineTotal: { toString(): string };
    };
  }): Promise<MockPurchaseItem> {
    const row: MockPurchaseItem = {
      id: `pi-${state.nextPurchaseItemId++}`,
      purchaseId: data.purchaseId,
      productId: data.productId,
      quantity: data.quantity,
      unitBuyPrice: data.unitBuyPrice.toString(),
      lineTotal: data.lineTotal.toString(),
    };
    state.purchaseItems.push(row);
    return Promise.resolve({ ...row });
  }

  // ---- Inventory + InventoryMovement (used by applyMovement) -----------
  function inventoryFindUniqueOrThrow({
    where,
  }: {
    where: { productId: string };
  }): Promise<MockInventory> {
    if (state.nextInventoryFindError !== null) {
      const errSpec = state.nextInventoryFindError;
      state.nextInventoryFindError = null;
      throw makeKnownError(errSpec.code, 'inventory.findUniqueOrThrow simulated error');
    }
    const row = state.inventories.find((i) => i.productId === where.productId);
    if (!row) throw makeKnownError('P2025', 'No Inventory found');
    return Promise.resolve({ ...row });
  }

  function inventoryUpdate({
    where,
    data,
  }: {
    where: { productId: string };
    data: { onHand: number };
  }): Promise<MockInventory> {
    const row = state.inventories.find((i) => i.productId === where.productId);
    if (!row) throw makeKnownError('P2025', 'No Inventory found');
    row.onHand = data.onHand;
    row.updatedAt = new Date();
    return Promise.resolve({ ...row });
  }

  function inventoryMovementCreate({
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

  // ---- JournalEntry delegate -------------------------------------------
  function journalEntryCreate({
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

  // Tx-shaped delegate map handed to `$transaction` callbacks. Mirrors
  // the surface the purchase service touches inside one transaction:
  //   - `purchase.create` for the header,
  //   - `purchaseItem.create` per line,
  //   - `inventory.findUniqueOrThrow` + `inventory.update` +
  //     `inventoryMovement.create` (driven by `applyMovement`),
  //   - `journalEntry.create` for the replay payload.
  const tx = {
    purchase: {
      create: purchaseCreate,
    },
    purchaseItem: {
      create: purchaseItemCreate,
    },
    inventory: {
      findUniqueOrThrow: inventoryFindUniqueOrThrow,
      update: inventoryUpdate,
    },
    inventoryMovement: {
      create: inventoryMovementCreate,
    },
    journalEntry: {
      create: journalEntryCreate,
    },
  };

  async function $transaction<T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> {
    // Snapshot mutable state so an in-tx throw rolls everything back —
    // matching Prisma's real `$transaction` semantics. This is what
    // makes "FK_VIOLATION leaves no row" observable: header, items,
    // movements, AND journal must all roll back together.
    const snapshot = {
      purchases: state.purchases.map((p) => ({ ...p })),
      purchaseItems: state.purchaseItems.map((p) => ({ ...p })),
      inventories: state.inventories.map((i) => ({ ...i })),
      movements: state.movements.map((m) => ({ ...m })),
      journalEntries: state.journalEntries.map((j) => ({ ...j })),
      nextPurchaseId: state.nextPurchaseId,
      nextPurchaseItemId: state.nextPurchaseItemId,
      nextMovementId: state.nextMovementId,
      nextJournalId: state.nextJournalId,
    };
    try {
      return await cb(tx);
    } catch (err) {
      state.purchases = snapshot.purchases;
      state.purchaseItems = snapshot.purchaseItems;
      state.inventories = snapshot.inventories;
      state.movements = snapshot.movements;
      state.journalEntries = snapshot.journalEntries;
      state.nextPurchaseId = snapshot.nextPurchaseId;
      state.nextPurchaseItemId = snapshot.nextPurchaseItemId;
      state.nextMovementId = snapshot.nextMovementId;
      state.nextJournalId = snapshot.nextJournalId;
      throw err;
    }
  }

  return {
    prisma: {
      purchase: {
        create: purchaseCreate,
        findMany: purchaseFindMany,
        count: purchaseCount,
      },
      purchaseItem: {
        create: purchaseItemCreate,
      },
      inventory: {
        findUniqueOrThrow: inventoryFindUniqueOrThrow,
        update: inventoryUpdate,
      },
      inventoryMovement: {
        create: inventoryMovementCreate,
      },
      journalEntry: {
        create: journalEntryCreate,
      },
      $transaction,
    },
  };
});

// Imports MUST come after `vi.mock`.
import { PurchaseService } from '@main/services/purchase.service';

import type { PurchaseInput } from '@shared/dto/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapOk<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; details?: unknown } },
): T {
  if (!result.ok) {
    throw new Error(`expected Ok, got Err(${result.error.code})`);
  }
  return result.value;
}

function expectErr(
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; details?: unknown } },
  code: string,
  details?: Record<string, unknown>,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
    if (details !== undefined) {
      expect(result.error.details).toEqual(details);
    }
  }
}

function seedSupplier(id: string, name = `Sup-${id}`): void {
  mockState.state.suppliers.push({ id, name });
}

function seedInventory(productId: string, onHand: number): void {
  mockState.state.inventories.push({
    productId,
    onHand,
    updatedAt: new Date(),
  });
}

function seedPurchase(overrides: Partial<{
  id: string;
  supplierId: string;
  invoiceNo: string | null;
  total: string;
  createdAt: Date;
}> = {}): string {
  const id = overrides.id ?? `pre-${mockState.state.purchases.length}`;
  mockState.state.purchases.push({
    id,
    supplierId: overrides.supplierId ?? 'sup-1',
    invoiceNo: overrides.invoiceNo ?? null,
    total: overrides.total ?? '10.00',
    createdAt: overrides.createdAt ?? new Date(`2024-02-${String(mockState.state.purchases.length + 1).padStart(2, '0')}T10:00:00Z`),
  });
  return id;
}

const ctx = { userId: 'u-admin' };

const baseInput: PurchaseInput = {
  supplierId: 'sup-1',
  invoiceNo: 'INV-1',
  items: [
    { productId: 'p-1', quantity: 2, unitBuyPrice: '10.00' },
  ],
};

beforeEach(() => {
  mockState.reset();
  // Default fixture: one supplier + one product with inventory.
  seedSupplier('sup-1', 'Acme');
  seedInventory('p-1', 0);
});

afterEach(() => {
  mockState.reset();
});

// ---------------------------------------------------------------------------
// Surface checks
// ---------------------------------------------------------------------------

describe('PurchaseService surface', () => {
  it('exposes create on the service literal', () => {
    expect(typeof PurchaseService.create).toBe('function');
  });

  it('exposes list on the service literal', () => {
    expect(typeof PurchaseService.list).toBe('function');
  });

  it('exposes count on the service literal', () => {
    expect(typeof PurchaseService.count).toBe('function');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PurchaseService)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// create — validation (Req 5.1, 5.3)
// ---------------------------------------------------------------------------

describe('PurchaseService.create: validation', () => {
  it('rejects empty supplierId with VALIDATION { field: "supplierId" }', async () => {
    const result = await PurchaseService.create({ ...baseInput, supplierId: '' }, ctx);
    expectErr(result, 'VALIDATION', { field: 'supplierId' });
    expect(mockState.state.purchases).toHaveLength(0);
  });

  it('rejects non-string supplierId with VALIDATION { field: "supplierId" }', async () => {
    const result = await PurchaseService.create(
      { ...baseInput, supplierId: 123 as unknown as string },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'supplierId' });
  });

  it('rejects an invoiceNo longer than 50 chars with VALIDATION { field: "invoiceNo" }', async () => {
    const result = await PurchaseService.create(
      { ...baseInput, invoiceNo: 'a'.repeat(51) },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'invoiceNo' });
  });

  it('rejects a non-string invoiceNo (excluding null) with VALIDATION { field: "invoiceNo" }', async () => {
    const result = await PurchaseService.create(
      { ...baseInput, invoiceNo: 42 as unknown as string },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'invoiceNo' });
  });

  it('rejects a missing items array with VALIDATION { field: "items" }', async () => {
    const result = await PurchaseService.create(
      { ...baseInput, items: undefined as unknown as PurchaseInput['items'] },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'items' });
  });

  it('rejects an empty items array with VALIDATION { field: "items" }', async () => {
    const result = await PurchaseService.create({ ...baseInput, items: [] }, ctx);
    expectErr(result, 'VALIDATION', { field: 'items' });
  });

  it('rejects a non-array items input with VALIDATION { field: "items" }', async () => {
    const result = await PurchaseService.create(
      { ...baseInput, items: 'oops' as unknown as PurchaseInput['items'] },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'items' });
  });

  it('rejects an empty productId on item N with VALIDATION { field: "items[N].productId" }', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [
          { productId: 'p-1', quantity: 1, unitBuyPrice: '5' },
          { productId: '', quantity: 1, unitBuyPrice: '5' },
        ],
      },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'items[1].productId' });
  });

  it('rejects quantity < 1 with VALIDATION { field: "items[N].quantity" }', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [{ productId: 'p-1', quantity: 0, unitBuyPrice: '5' }],
      },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'items[0].quantity' });
  });

  it('rejects negative quantity with VALIDATION { field: "items[N].quantity" }', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [{ productId: 'p-1', quantity: -1, unitBuyPrice: '5' }],
      },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'items[0].quantity' });
  });

  it('rejects fractional quantity with VALIDATION { field: "items[N].quantity" }', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [{ productId: 'p-1', quantity: 1.5, unitBuyPrice: '5' }],
      },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'items[0].quantity' });
  });

  it('rejects negative unitBuyPrice with VALIDATION { field: "items[N].unitBuyPrice" }', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [{ productId: 'p-1', quantity: 1, unitBuyPrice: '-1.00' }],
      },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'items[0].unitBuyPrice' });
  });

  it('rejects NaN unitBuyPrice with VALIDATION { field: "items[N].unitBuyPrice" }', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [{ productId: 'p-1', quantity: 1, unitBuyPrice: 'NaN' }],
      },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'items[0].unitBuyPrice' });
  });

  it('rejects unparseable unitBuyPrice with VALIDATION { field: "items[N].unitBuyPrice" }', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [{ productId: 'p-1', quantity: 1, unitBuyPrice: 'free!' }],
      },
      ctx,
    );
    expectErr(result, 'VALIDATION', { field: 'items[0].unitBuyPrice' });
  });

  it('accepts unitBuyPrice "0" (free items) and computes a zero lineTotal', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [{ productId: 'p-1', quantity: 3, unitBuyPrice: '0' }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const item = mockState.state.purchaseItems[0]!;
    expect(item.lineTotal).toBe('0');
    expect(mockState.state.purchases[0]!.total).toBe('0');
  });

  it('accepts decimal unitBuyPrice values like "12.5"', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [{ productId: 'p-1', quantity: 2, unitBuyPrice: '12.5' }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(mockState.state.purchaseItems[0]!.lineTotal).toBe('25');
    expect(mockState.state.purchases[0]!.total).toBe('25');
  });

  it('does not write any rows on a validation failure', async () => {
    const result = await PurchaseService.create(
      {
        ...baseInput,
        items: [{ productId: 'p-1', quantity: 0, unitBuyPrice: '5' }],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(mockState.state.purchases).toHaveLength(0);
    expect(mockState.state.purchaseItems).toHaveLength(0);
    expect(mockState.state.movements).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// create — happy path (Req 5.1, 5.2, 5.3, 5.4, 11.2)
// ---------------------------------------------------------------------------

describe('PurchaseService.create: atomic happy path', () => {
  it('returns Ok({ purchaseId }) and writes header + items + movements + journal', async () => {
    seedInventory('p-2', 5);

    const result = await PurchaseService.create(
      {
        supplierId: 'sup-1',
        invoiceNo: 'INV-100',
        items: [
          { productId: 'p-1', quantity: 2, unitBuyPrice: '10.00' },
          { productId: 'p-2', quantity: 3, unitBuyPrice: '4.50' },
        ],
      },
      ctx,
    );

    const value = unwrapOk(result);
    expect(typeof value.purchaseId).toBe('string');
    expect(value.purchaseId.length).toBeGreaterThan(0);

    expect(mockState.state.purchases).toHaveLength(1);
    expect(mockState.state.purchaseItems).toHaveLength(2);
    expect(mockState.state.movements).toHaveLength(2);
    expect(mockState.state.journalEntries).toHaveLength(1);

    const header = mockState.state.purchases[0]!;
    expect(header.id).toBe(value.purchaseId);
    expect(header.supplierId).toBe('sup-1');
    expect(header.invoiceNo).toBe('INV-100');
    // header.total = sum(lineTotals) = 2*10 + 3*4.5 = 33.5
    expect(header.total).toBe('33.5');
  });

  it('persists each line with the correct lineTotal (Req 5.3 — line_total identity)', async () => {
    seedInventory('p-2', 0);

    await PurchaseService.create(
      {
        supplierId: 'sup-1',
        items: [
          { productId: 'p-1', quantity: 2, unitBuyPrice: '10.00' },
          { productId: 'p-2', quantity: 7, unitBuyPrice: '3.25' },
        ],
      },
      ctx,
    );

    const lines = mockState.state.purchaseItems.slice().sort((a, b) =>
      a.productId.localeCompare(b.productId),
    );
    expect(lines[0]!.productId).toBe('p-1');
    expect(lines[0]!.quantity).toBe(2);
    expect(lines[0]!.unitBuyPrice).toBe('10');
    expect(lines[0]!.lineTotal).toBe('20');

    expect(lines[1]!.productId).toBe('p-2');
    expect(lines[1]!.quantity).toBe(7);
    expect(lines[1]!.unitBuyPrice).toBe('3.25');
    expect(lines[1]!.lineTotal).toBe('22.75');
  });

  it('header total equals sum(lineTotals)', async () => {
    seedInventory('p-2', 0);
    seedInventory('p-3', 0);

    await PurchaseService.create(
      {
        supplierId: 'sup-1',
        items: [
          { productId: 'p-1', quantity: 1, unitBuyPrice: '0.10' },
          { productId: 'p-2', quantity: 1, unitBuyPrice: '0.20' },
          { productId: 'p-3', quantity: 1, unitBuyPrice: '0.30' },
        ],
      },
      ctx,
    );

    const headerTotal = mockState.state.purchases[0]!.total;
    const sumOfLines = mockState.state.purchaseItems.reduce((acc, line) => {
      return acc + Number(line.lineTotal);
    }, 0);
    // 0.1 + 0.2 + 0.3 — Decimal-precise ⇒ exactly 0.6 (avoiding the
    // float artefact 0.6000000000000001 you would see if Number-add'd).
    expect(Number(headerTotal)).toBeCloseTo(sumOfLines, 10);
    expect(headerTotal).toBe('0.6');
  });

  it('calls applyMovement once per line with positive delta and "purchase" discriminators (Req 5.4)', async () => {
    seedInventory('p-2', 0);

    await PurchaseService.create(
      {
        supplierId: 'sup-1',
        items: [
          { productId: 'p-1', quantity: 4, unitBuyPrice: '1' },
          { productId: 'p-2', quantity: 6, unitBuyPrice: '1' },
        ],
      },
      ctx,
    );

    const movements = mockState.state.movements;
    expect(movements).toHaveLength(2);

    for (const m of movements) {
      expect(m.movementType).toBe('purchase');
      expect(m.referenceType).toBe('purchase');
      expect(m.referenceId).toBe(mockState.state.purchases[0]!.id);
      expect(m.userId).toBe('u-admin');
      expect(m.quantityDelta).toBeGreaterThan(0);
    }

    const byProduct = new Map(movements.map((m) => [m.productId, m.quantityDelta] as const));
    expect(byProduct.get('p-1')).toBe(4);
    expect(byProduct.get('p-2')).toBe(6);

    // And the cached on-hand reflects each delta.
    const inv1 = mockState.state.inventories.find((i) => i.productId === 'p-1');
    const inv2 = mockState.state.inventories.find((i) => i.productId === 'p-2');
    expect(inv1?.onHand).toBe(4);
    expect(inv2?.onHand).toBe(6);
  });

  it('writes exactly one journal entry of opType "purchase" with a replay-friendly payload', async () => {
    seedInventory('p-2', 0);

    const result = await PurchaseService.create(
      {
        supplierId: 'sup-1',
        invoiceNo: 'INV-77',
        items: [
          { productId: 'p-1', quantity: 2, unitBuyPrice: '10.00' },
          { productId: 'p-2', quantity: 1, unitBuyPrice: '5.50' },
        ],
      },
      ctx,
    );
    const value = unwrapOk(result);

    expect(mockState.state.journalEntries).toHaveLength(1);
    const entry = mockState.state.journalEntries[0]!;
    expect(entry.opType).toBe('purchase');

    const payload = JSON.parse(entry.payload) as {
      purchaseId: string;
      supplierId: string;
      invoiceNo: string | null;
      total: string;
      items: { productId: string; quantity: number; unitBuyPrice: string; lineTotal: string }[];
      userId: string;
      timestamp: string;
    };
    expect(payload.purchaseId).toBe(value.purchaseId);
    expect(payload.supplierId).toBe('sup-1');
    expect(payload.invoiceNo).toBe('INV-77');
    expect(payload.total).toBe('25.5');
    expect(payload.items).toHaveLength(2);
    expect(payload.userId).toBe('u-admin');
    expect(typeof payload.timestamp).toBe('string');
    expect(new Date(payload.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('persists null invoiceNo when caller omits it', async () => {
    const { invoiceNo: _omitted, ...rest } = baseInput;
    void _omitted;
    const result = await PurchaseService.create(rest, ctx);
    expect(result.ok).toBe(true);
    expect(mockState.state.purchases[0]!.invoiceNo).toBeNull();
  });

  it('persists null invoiceNo when caller passes null explicitly', async () => {
    const result = await PurchaseService.create({ ...baseInput, invoiceNo: null }, ctx);
    expect(result.ok).toBe(true);
    expect(mockState.state.purchases[0]!.invoiceNo).toBeNull();
  });

  it('trims and persists a non-empty invoiceNo', async () => {
    const result = await PurchaseService.create(
      { ...baseInput, invoiceNo: '  INV-PADDED  ' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(mockState.state.purchases[0]!.invoiceNo).toBe('INV-PADDED');
  });

  it('treats whitespace-only invoiceNo as null', async () => {
    const result = await PurchaseService.create({ ...baseInput, invoiceNo: '   ' }, ctx);
    expect(result.ok).toBe(true);
    expect(mockState.state.purchases[0]!.invoiceNo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// create — FK_VIOLATION mapping (Req 5.5, 11.2)
// ---------------------------------------------------------------------------

describe('PurchaseService.create: FK_VIOLATION mapping', () => {
  it('maps Prisma P2003 (FK violation on supplierId) to Err(FK_VIOLATION, { reason: "not_found" })', async () => {
    mockState.state.nextPurchaseCreateError = { code: 'P2003' };

    const result = await PurchaseService.create(baseInput, ctx);
    expectErr(result, 'FK_VIOLATION', { reason: 'not_found' });

    // Atomicity (Req 5.5, 11.2): no header, no items, no movements, no journal.
    expect(mockState.state.purchases).toHaveLength(0);
    expect(mockState.state.purchaseItems).toHaveLength(0);
    expect(mockState.state.movements).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });

  it('maps Prisma P2025 (Inventory record not found) to Err(FK_VIOLATION, { reason: "not_found" })', async () => {
    // No inventory row for p-missing → applyMovement throws P2025 from
    // findUniqueOrThrow.
    const result = await PurchaseService.create(
      {
        supplierId: 'sup-1',
        items: [{ productId: 'p-missing', quantity: 1, unitBuyPrice: '10.00' }],
      },
      ctx,
    );
    expectErr(result, 'FK_VIOLATION', { reason: 'not_found' });

    // Rollback semantics: the in-tx header + items written before the
    // applyMovement throw must be gone.
    expect(mockState.state.purchases).toHaveLength(0);
    expect(mockState.state.purchaseItems).toHaveLength(0);
    expect(mockState.state.movements).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });

  it('lets unknown Prisma errors propagate', async () => {
    mockState.state.nextPurchaseCreateError = { code: 'P9999' };

    await expect(PurchaseService.create(baseInput, ctx)).rejects.toMatchObject({
      code: 'P9999',
    });
  });
});

// ---------------------------------------------------------------------------
// list (Req 16.1, 16.2, 16.3, 16.4)
// ---------------------------------------------------------------------------

describe('PurchaseService.list', () => {
  it('returns an empty page on an empty table', async () => {
    const result = await PurchaseService.list({});
    const value = unwrapOk(result);
    expect(value.rows).toEqual([]);
    expect(value.nextCursor).toBeNull();
  });

  it('orders by (createdAt DESC, id DESC) by default', async () => {
    seedPurchase({ id: 'older', createdAt: new Date('2024-01-01T00:00:00Z') });
    seedPurchase({ id: 'newer', createdAt: new Date('2024-03-01T00:00:00Z') });
    seedPurchase({ id: 'middle', createdAt: new Date('2024-02-01T00:00:00Z') });

    const value = unwrapOk(await PurchaseService.list({}));
    expect(value.rows.map((r) => r.id)).toEqual(['newer', 'middle', 'older']);
  });

  it('projects supplierName + itemCount onto each row', async () => {
    seedSupplier('sup-x', 'Other');
    seedPurchase({ id: 'p-a', supplierId: 'sup-1', total: '10.00' });
    mockState.state.purchaseItems.push(
      { id: 'pi-1', purchaseId: 'p-a', productId: 'pr-1', quantity: 1, unitBuyPrice: '10', lineTotal: '10' },
      { id: 'pi-2', purchaseId: 'p-a', productId: 'pr-2', quantity: 2, unitBuyPrice: '5', lineTotal: '10' },
    );

    const value = unwrapOk(await PurchaseService.list({}));
    expect(value.rows).toHaveLength(1);
    const row = value.rows[0]!;
    expect(row.supplierName).toBe('Acme');
    expect(row.itemCount).toBe(2);
    expect(row.total).toBe('10');
    expect(typeof row.createdAt).toBe('string');
    expect(new Date(row.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('filters by supplierId', async () => {
    seedSupplier('sup-x', 'Other');
    seedPurchase({ id: 'a', supplierId: 'sup-1' });
    seedPurchase({ id: 'b', supplierId: 'sup-x' });
    seedPurchase({ id: 'c', supplierId: 'sup-1' });

    const value = unwrapOk(
      await PurchaseService.list({ filter: { supplierId: 'sup-1' } }),
    );
    expect(value.rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('filters by inclusive [dateFrom, dateTo] window', async () => {
    seedPurchase({ id: 'jan', createdAt: new Date('2024-01-15T00:00:00Z') });
    seedPurchase({ id: 'feb', createdAt: new Date('2024-02-15T00:00:00Z') });
    seedPurchase({ id: 'mar', createdAt: new Date('2024-03-15T00:00:00Z') });

    const value = unwrapOk(
      await PurchaseService.list({
        filter: {
          dateFrom: '2024-02-01T00:00:00.000Z',
          dateTo: '2024-02-28T23:59:59.999Z',
        },
      }),
    );
    expect(value.rows.map((r) => r.id)).toEqual(['feb']);
  });

  it('paginates by cursor and the walk completes when fewer than pageSize rows return', async () => {
    for (let i = 0; i < 5; i++) {
      seedPurchase({
        id: `p-${i}`,
        createdAt: new Date(`2024-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
      });
    }
    const first = unwrapOk(await PurchaseService.list({ pageSize: 2 }));
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = unwrapOk(
      await PurchaseService.list({ pageSize: 2, cursor: first.nextCursor! }),
    );
    expect(second.rows).toHaveLength(2);

    const third = unwrapOk(
      await PurchaseService.list({ pageSize: 2, cursor: second.nextCursor! }),
    );
    expect(third.rows).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    // No row appears in two pages.
    const all = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('returns Err(VALIDATION, { field: "cursor" }) on a malformed cursor', async () => {
    const result = await PurchaseService.list({ cursor: 'not-base64!!!' });
    expectErr(result, 'VALIDATION', { field: 'cursor' });
  });

  it('includes totalCount only when withCount is true', async () => {
    for (let i = 0; i < 4; i++) seedPurchase();

    const without = unwrapOk(await PurchaseService.list({ pageSize: 2 }));
    expect('totalCount' in without).toBe(false);

    const withCount = unwrapOk(
      await PurchaseService.list({ pageSize: 2, withCount: true }),
    );
    expect(withCount.totalCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe('PurchaseService.count', () => {
  it('returns the total count on an empty filter', async () => {
    seedPurchase();
    seedPurchase();
    seedPurchase();
    const value = unwrapOk(await PurchaseService.count({}));
    expect(value.totalCount).toBe(3);
  });

  it('respects the supplierId filter', async () => {
    seedSupplier('sup-x', 'Other');
    seedPurchase({ supplierId: 'sup-1' });
    seedPurchase({ supplierId: 'sup-x' });
    seedPurchase({ supplierId: 'sup-1' });
    const value = unwrapOk(
      await PurchaseService.count({ filter: { supplierId: 'sup-1' } }),
    );
    expect(value.totalCount).toBe(2);
  });

  it('respects the date window filter', async () => {
    seedPurchase({ createdAt: new Date('2024-01-15T00:00:00Z') });
    seedPurchase({ createdAt: new Date('2024-02-15T00:00:00Z') });
    seedPurchase({ createdAt: new Date('2024-03-15T00:00:00Z') });

    const value = unwrapOk(
      await PurchaseService.count({
        filter: {
          dateFrom: '2024-02-01T00:00:00.000Z',
          dateTo: '2024-02-28T23:59:59.999Z',
        },
      }),
    );
    expect(value.totalCount).toBe(1);
  });
});
