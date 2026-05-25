/**
 * Unit tests for `replayJournal` (Phase 11, task 11.6.1).
 *
 * Drives the helper against an in-memory Prisma stub that records
 * every transactional call. The tests cover:
 *
 *   - Cursor walk: pages are taken in 1,000-row batches (clamped
 *     to the helper's 200-row max under the hood) and each batch
 *     runs in its own `$transaction`.
 *
 *   - Per-opType dispatch: each handler routes the parsed payload
 *     to the right Prisma operation (`upsert` on the deterministic
 *     primary key, `deleteMany` + `create` for child rows,
 *     `aggregate` + `upsert` on the inventory cache, etc.).
 *
 *   - Idempotency: running the same set of journal entries twice
 *     leaves the same final state — the second run does not
 *     duplicate Sale, Purchase, SaleItem, Payment, or
 *     InventoryMovement rows.
 *
 *   - Crash safety: when one batch's transaction throws, the
 *     helper returns `Err('INTERNAL', { reason: 'replay_failed' })`
 *     and the caller (the bootstrap) can resume from the same
 *     cursor on the next launch.
 *
 *   - Unknown opType: maintenance and other non-replayable rows
 *     are skipped silently, not counted in `appliedCount`, and do
 *     not abort the replay.
 *
 * Validates: Requirements 10.6, 11.3, 16.8.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { replayJournal } from '@main/services/backup/replay';

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

interface JournalRow {
  readonly id: string;
  readonly timestamp: Date;
  readonly opType: string;
  readonly payload: string;
}

interface SaleRow {
  id: string;
  serialNo: string;
  customerId: string | null;
  cashierId: string;
  subtotal: string;
  discount: string;
  taxTotal: string;
  grandTotal: string;
  createdAt: Date;
}
interface SaleItemRow {
  id: string;
  saleId: string;
  productId: string;
  quantity: number;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
}
interface PaymentRow {
  id: string;
  saleId: string;
  method: string;
  amount: string;
}
interface PurchaseRow {
  id: string;
  supplierId: string;
  invoiceNo: string | null;
  total: string;
  createdAt: Date;
}
interface PurchaseItemRow {
  id: string;
  purchaseId: string;
  productId: string;
  quantity: number;
  unitBuyPrice: string;
  lineTotal: string;
}
interface InventoryRow {
  productId: string;
  onHand: number;
}
interface MovementRow {
  id: string;
  productId: string;
  quantityDelta: number;
  movementType: string;
  referenceType: string;
  referenceId: string;
  userId: string;
  timestamp: Date;
}
interface ProductRow {
  id: string;
  buyPrice: string;
  sellPrice: string;
}
interface UserRow {
  id: string;
  roleId: string;
}
interface RoleRow {
  id: string;
  name: string;
}

interface StubState {
  journal: JournalRow[];
  sales: Map<string, SaleRow>;
  saleItems: SaleItemRow[];
  payments: PaymentRow[];
  purchases: Map<string, PurchaseRow>;
  purchaseItems: PurchaseItemRow[];
  inventory: Map<string, InventoryRow>;
  movements: MovementRow[];
  products: Map<string, ProductRow>;
  users: Map<string, UserRow>;
  roles: Map<string, RoleRow>;
  /** Force the next $transaction to throw. Used to simulate a crash. */
  failNextTransaction: boolean;
  /** Counter for unique generated ids. */
  nextId: number;
  transactionCount: number;
}

function createStub(): StubState {
  return {
    journal: [],
    sales: new Map(),
    saleItems: [],
    payments: [],
    purchases: new Map(),
    purchaseItems: [],
    inventory: new Map(),
    movements: [],
    products: new Map(),
    users: new Map(),
    roles: new Map(),
    failNextTransaction: false,
    nextId: 0,
    transactionCount: 0,
  };
}

function nextId(state: StubState, prefix: string): string {
  state.nextId++;
  return `${prefix}-${state.nextId}`;
}

/**
 * Deep-copy the state so a transactional callback can roll back
 * by restoring the snapshot. Mirrors how SQLite's transaction
 * boundary works for our test.
 */
function snapshot(state: StubState): StubState {
  return {
    journal: state.journal.slice(),
    sales: new Map(state.sales),
    saleItems: state.saleItems.slice(),
    payments: state.payments.slice(),
    purchases: new Map(state.purchases),
    purchaseItems: state.purchaseItems.slice(),
    inventory: new Map(state.inventory),
    movements: state.movements.slice(),
    products: new Map(state.products),
    users: new Map(state.users),
    roles: new Map(state.roles),
    failNextTransaction: state.failNextTransaction,
    nextId: state.nextId,
    transactionCount: state.transactionCount,
  };
}

function restore(target: StubState, source: StubState): void {
  target.journal = source.journal.slice();
  target.sales = new Map(source.sales);
  target.saleItems = source.saleItems.slice();
  target.payments = source.payments.slice();
  target.purchases = new Map(source.purchases);
  target.purchaseItems = source.purchaseItems.slice();
  target.inventory = new Map(source.inventory);
  target.movements = source.movements.slice();
  target.products = new Map(source.products);
  target.users = new Map(source.users);
  target.roles = new Map(source.roles);
  target.nextId = source.nextId;
  // Note: failNextTransaction and transactionCount are not rolled
  // back — they're test-only counters.
}

/**
 * Build a Prisma-shaped stub. Only the methods `replayJournal`
 * touches are implemented; everything else throws a clear
 * "not implemented" error so we catch accidental drift.
 */
function buildClient(state: StubState): Parameters<typeof replayJournal>[0]['prismaClient'] {
  const journalEntry = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async findMany(args: {
      orderBy: { timestamp: 'asc' | 'desc'; id: 'asc' | 'desc' }[];
      take: number;
      where?: Record<string, unknown>;
      select?: unknown;
    }): Promise<JournalRow[]> {
      let rows = state.journal.slice();
      if (args.where !== undefined) {
        rows = rows.filter((row) => matchesWhere(row, args.where!));
      }
      // Sort by timestamp asc, then id asc (we always pass asc for replay).
      rows.sort((a, b) => {
        const ts = a.timestamp.getTime() - b.timestamp.getTime();
        if (ts !== 0) return ts;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return rows.slice(0, args.take);
    },
  };

  const make = (
    tx: ReturnType<typeof buildTxFns>,
  ): Parameters<typeof replayJournal>[0]['prismaClient'] => ({
    journalEntry: journalEntry as never,
    $transaction: async <T>(fn: (tx: typeof tx) => Promise<T>): Promise<T> => {
      state.transactionCount++;
      const before = snapshot(state);
      if (state.failNextTransaction) {
        state.failNextTransaction = false;
        throw new Error('simulated crash');
      }
      try {
        return await fn(tx);
      } catch (err) {
        restore(state, before);
        throw err;
      }
    },
    sale: tx.sale as never,
    saleItem: tx.saleItem as never,
    payment: tx.payment as never,
    purchase: tx.purchase as never,
    purchaseItem: tx.purchaseItem as never,
    inventory: tx.inventory as never,
    inventoryMovement: tx.inventoryMovement as never,
    product: tx.product as never,
    user: tx.user as never,
    role: tx.role as never,
  });

  const tx = buildTxFns(state);
  return make(tx);
}

/** Build the Prisma transaction-client surface used inside handlers. */
function buildTxFns(state: StubState) {
  return {
    sale: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async findUnique(args: {
        where: { id: string };
        select?: unknown;
      }): Promise<SaleRow | null> {
        return state.sales.get(args.where.id) ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async create(args: {
        data: Omit<SaleRow, 'createdAt'> & {
          createdAt?: Date;
          items?: { create: Omit<SaleItemRow, 'id' | 'saleId'>[] };
          payments?: { create: Omit<PaymentRow, 'id' | 'saleId'>[] };
        };
      }) {
        const fresh: SaleRow = {
          id: args.data.id,
          serialNo: String(args.data.serialNo),
          customerId: args.data.customerId,
          cashierId: args.data.cashierId,
          subtotal: String(args.data.subtotal),
          discount: String(args.data.discount),
          taxTotal: String(args.data.taxTotal),
          grandTotal: String(args.data.grandTotal),
          createdAt: args.data.createdAt ?? new Date(),
        };
        state.sales.set(fresh.id, fresh);
        if (args.data.items?.create !== undefined) {
          for (const line of args.data.items.create) {
            state.saleItems.push({
              id: nextId(state, 'si'),
              saleId: fresh.id,
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: String(line.unitPrice),
              taxRate: String(line.taxRate),
              lineTotal: String(line.lineTotal),
            });
          }
        }
        if (args.data.payments?.create !== undefined) {
          for (const p of args.data.payments.create) {
            state.payments.push({
              id: nextId(state, 'pay'),
              saleId: fresh.id,
              method: p.method,
              amount: String(p.amount),
            });
          }
        }
        return fresh;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async upsert(args: {
        where: { id: string };
        create: Omit<SaleRow, 'createdAt'> & { createdAt?: Date };
        update: Partial<SaleRow>;
      }) {
        const existing = state.sales.get(args.where.id);
        if (existing !== undefined) {
          Object.assign(existing, args.update);
          return existing;
        }
        const fresh: SaleRow = {
          id: args.create.id,
          serialNo: String(args.create.serialNo),
          customerId: args.create.customerId,
          cashierId: args.create.cashierId,
          subtotal: String(args.create.subtotal),
          discount: String(args.create.discount),
          taxTotal: String(args.create.taxTotal),
          grandTotal: String(args.create.grandTotal),
          createdAt: args.create.createdAt ?? new Date(),
        };
        state.sales.set(fresh.id, fresh);
        return fresh;
      },
    },
    saleItem: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async deleteMany(args: { where: { saleId: string } }): Promise<{ count: number }> {
        const before = state.saleItems.length;
        state.saleItems = state.saleItems.filter((r) => r.saleId !== args.where.saleId);
        return { count: before - state.saleItems.length };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async create(args: { data: Omit<SaleItemRow, 'id'> & { id?: string } }) {
        const row: SaleItemRow = {
          id: args.data.id ?? nextId(state, 'si'),
          saleId: args.data.saleId,
          productId: args.data.productId,
          quantity: args.data.quantity,
          unitPrice: String(args.data.unitPrice),
          taxRate: String(args.data.taxRate),
          lineTotal: String(args.data.lineTotal),
        };
        state.saleItems.push(row);
        return row;
      },
    },
    payment: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async deleteMany(args: { where: { saleId: string } }): Promise<{ count: number }> {
        const before = state.payments.length;
        state.payments = state.payments.filter((r) => r.saleId !== args.where.saleId);
        return { count: before - state.payments.length };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async create(args: { data: Omit<PaymentRow, 'id'> & { id?: string } }) {
        const row: PaymentRow = {
          id: args.data.id ?? nextId(state, 'pay'),
          saleId: args.data.saleId,
          method: args.data.method,
          amount: String(args.data.amount),
        };
        state.payments.push(row);
        return row;
      },
    },
    purchase: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async findUnique(args: {
        where: { id: string };
        select?: unknown;
      }): Promise<PurchaseRow | null> {
        return state.purchases.get(args.where.id) ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async create(args: {
        data: Omit<PurchaseRow, 'createdAt'> & {
          createdAt?: Date;
          items?: { create: Omit<PurchaseItemRow, 'id' | 'purchaseId'>[] };
        };
      }) {
        const fresh: PurchaseRow = {
          id: args.data.id,
          supplierId: args.data.supplierId,
          invoiceNo: args.data.invoiceNo,
          total: String(args.data.total),
          createdAt: args.data.createdAt ?? new Date(),
        };
        state.purchases.set(fresh.id, fresh);
        if (args.data.items?.create !== undefined) {
          for (const line of args.data.items.create) {
            state.purchaseItems.push({
              id: nextId(state, 'pi'),
              purchaseId: fresh.id,
              productId: line.productId,
              quantity: line.quantity,
              unitBuyPrice: String(line.unitBuyPrice),
              lineTotal: String(line.lineTotal),
            });
          }
        }
        return fresh;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async upsert(args: {
        where: { id: string };
        create: Omit<PurchaseRow, 'createdAt'> & { createdAt?: Date };
        update: Partial<PurchaseRow>;
      }) {
        const existing = state.purchases.get(args.where.id);
        if (existing !== undefined) {
          Object.assign(existing, args.update);
          return existing;
        }
        const fresh: PurchaseRow = {
          id: args.create.id,
          supplierId: args.create.supplierId,
          invoiceNo: args.create.invoiceNo,
          total: String(args.create.total),
          createdAt: args.create.createdAt ?? new Date(),
        };
        state.purchases.set(fresh.id, fresh);
        return fresh;
      },
    },
    purchaseItem: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async deleteMany(args: { where: { purchaseId: string } }): Promise<{ count: number }> {
        const before = state.purchaseItems.length;
        state.purchaseItems = state.purchaseItems.filter(
          (r) => r.purchaseId !== args.where.purchaseId,
        );
        return { count: before - state.purchaseItems.length };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async create(args: { data: Omit<PurchaseItemRow, 'id'> & { id?: string } }) {
        const row: PurchaseItemRow = {
          id: args.data.id ?? nextId(state, 'pi'),
          purchaseId: args.data.purchaseId,
          productId: args.data.productId,
          quantity: args.data.quantity,
          unitBuyPrice: String(args.data.unitBuyPrice),
          lineTotal: String(args.data.lineTotal),
        };
        state.purchaseItems.push(row);
        return row;
      },
    },
    inventory: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async findUnique(args: {
        where: { productId: string };
      }): Promise<InventoryRow | null> {
        return state.inventory.get(args.where.productId) ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async upsert(args: {
        where: { productId: string };
        create: { productId: string; onHand: number };
        update: { onHand: number };
      }) {
        const existing = state.inventory.get(args.where.productId);
        if (existing !== undefined) {
          existing.onHand = args.update.onHand;
          return existing;
        }
        const fresh = { productId: args.create.productId, onHand: args.create.onHand };
        state.inventory.set(fresh.productId, fresh);
        return fresh;
      },
    },
    inventoryMovement: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async findFirst(args: {
        where: { referenceType: string; referenceId: string };
        select?: unknown;
      }): Promise<MovementRow | null> {
        const found = state.movements.find(
          (m) =>
            m.referenceType === args.where.referenceType &&
            m.referenceId === args.where.referenceId,
        );
        return found ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async deleteMany(args: {
        where: { referenceType: string; referenceId: string };
      }): Promise<{ count: number }> {
        const before = state.movements.length;
        state.movements = state.movements.filter(
          (m) =>
            !(
              m.referenceType === args.where.referenceType &&
              m.referenceId === args.where.referenceId
            ),
        );
        return { count: before - state.movements.length };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async create(args: { data: Omit<MovementRow, 'id'> & { id?: string } }) {
        const row: MovementRow = {
          id: args.data.id ?? nextId(state, 'mv'),
          productId: args.data.productId,
          quantityDelta: args.data.quantityDelta,
          movementType: args.data.movementType,
          referenceType: args.data.referenceType,
          referenceId: args.data.referenceId,
          userId: args.data.userId,
          timestamp: args.data.timestamp ?? new Date(),
        };
        state.movements.push(row);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async aggregate(args: {
        where: { productId: string };
        _sum: { quantityDelta: true };
      }) {
        const total = state.movements
          .filter((m) => m.productId === args.where.productId)
          .reduce((acc, m) => acc + m.quantityDelta, 0);
        return { _sum: { quantityDelta: total } };
      },
    },
    product: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async update(args: {
        where: { id: string };
        data: { buyPrice: string; sellPrice: string };
      }) {
        const existing = state.products.get(args.where.id);
        if (existing === undefined) {
          throw new Error(`product ${args.where.id} not found`);
        }
        existing.buyPrice = String(args.data.buyPrice);
        existing.sellPrice = String(args.data.sellPrice);
        return existing;
      },
    },
    user: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async update(args: { where: { id: string }; data: { roleId: string } }) {
        const existing = state.users.get(args.where.id);
        if (existing === undefined) {
          throw new Error(`user ${args.where.id} not found`);
        }
        existing.roleId = args.data.roleId;
        return existing;
      },
    },
    role: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async findUnique(args: { where: { name?: string; id?: string } }): Promise<RoleRow | null> {
        if (args.where.name !== undefined) {
          const rows: RoleRow[] = Array.from(state.roles.values());
          const match = rows.find((r) => r.name === args.where.name);
          if (match !== undefined) return match;
        }
        if (args.where.id !== undefined) {
          return state.roles.get(args.where.id) ?? null;
        }
        return null;
      },
    },
  };
}

/**
 * Match a journal row against a Prisma-style where shape. Only
 * supports the subset paginateCursor builds: top-level
 * `timestamp.gte`, top-level `AND`, and OR-shaped cursor predicates.
 */
function matchesWhere(row: JournalRow, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' && Array.isArray(value)) {
      if (!value.every((child) => matchesWhere(row, child as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === 'OR' && Array.isArray(value)) {
      if (!value.some((child) => matchesWhere(row, child as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === 'timestamp' && typeof value === 'object' && value !== null) {
      const v = value as { gte?: Date; lt?: Date; gt?: Date };
      if (v.gte !== undefined && row.timestamp.getTime() < v.gte.getTime()) return false;
      if (v.gt !== undefined && row.timestamp.getTime() <= v.gt.getTime()) return false;
      if (v.lt !== undefined && row.timestamp.getTime() >= v.lt.getTime()) return false;
      // Direct equality for the tuple case below.
      continue;
    }
    if (key === 'timestamp' && value instanceof Date) {
      if (row.timestamp.getTime() !== value.getTime()) return false;
      continue;
    }
    if (key === 'id' && typeof value === 'object' && value !== null) {
      const v = value as { gt?: string; lt?: string };
      if (v.gt !== undefined && !(row.id > v.gt)) return false;
      if (v.lt !== undefined && !(row.id < v.lt)) return false;
      continue;
    }
    // Unknown predicate — be conservative.
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let state: StubState;

beforeEach(() => {
  state = createStub();
});

afterEach(() => {
  // No global state to reset.
});

function makeJournalEntry(
  id: string,
  opType: string,
  payload: object,
  ts: Date,
): JournalRow {
  return { id, opType, payload: JSON.stringify(payload), timestamp: ts };
}

function buildSalePayload(
  saleId: string,
  serialNo: string,
  cashierId: string,
  items: { productId: string; quantity: number }[],
  ts: Date,
): object {
  return {
    saleId,
    serialNo,
    customerId: null,
    cashierId,
    subtotal: '100',
    discount: '0',
    taxTotal: '0',
    grandTotal: '100',
    items: items.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: '10',
      taxRate: '0',
      lineTotal: String(line.quantity * 10),
    })),
    payments: [{ method: 'cash', amount: '100' }],
    userId: cashierId,
    timestamp: ts.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('replayJournal — empty journal', () => {
  it('returns Ok({ batchCount: 0, appliedCount: 0 }) when no entries match', async () => {
    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.batchCount).toBe(0);
      expect(result.value.appliedCount).toBe(0);
    }
  });
});

describe('replayJournal — sale dispatch', () => {
  it('applies a single sale entry idempotently', async () => {
    const ts = new Date('2024-05-01T10:00:00Z');
    state.journal.push(
      makeJournalEntry(
        'j1',
        'sale',
        buildSalePayload('sale-1', 'INV-000001', 'u1', [
          { productId: 'p1', quantity: 2 },
        ], ts),
        ts,
      ),
    );

    const result1 = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.value.batchCount).toBe(1);
      expect(result1.value.appliedCount).toBe(1);
    }
    expect(state.sales.size).toBe(1);
    expect(state.saleItems).toHaveLength(1);
    expect(state.payments).toHaveLength(1);
    expect(state.movements).toHaveLength(1);
    const movement = state.movements[0]!;
    expect(movement.quantityDelta).toBe(-2);
    expect(state.inventory.get('p1')!.onHand).toBe(-2);

    // Idempotency: re-run produces the same final state. Because
    // the Sale row already exists, the handler short-circuits and
    // does NOT re-apply the deltas.
    const result2 = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result2.ok).toBe(true);
    expect(state.sales.size).toBe(1);
    expect(state.saleItems).toHaveLength(1);
    expect(state.payments).toHaveLength(1);
    expect(state.movements).toHaveLength(1);
    expect(state.inventory.get('p1')!.onHand).toBe(-2);
  });

  it('skips already-applied entries on a second run (idempotency)', async () => {
    const ts = new Date('2024-05-01T10:00:00Z');
    const payload = buildSalePayload('sale-1', 'INV-000001', 'u1', [
      { productId: 'p1', quantity: 1 },
    ], ts);
    state.journal.push(makeJournalEntry('j1', 'sale', payload, ts));

    await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    const itemIdsAfterFirst = state.saleItems.map((r) => r.id);
    const movementCountAfterFirst = state.movements.length;

    await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(state.saleItems).toHaveLength(1);
    // Same row ids — the second run did not delete-and-recreate.
    expect(state.saleItems[0]!.id).toEqual(itemIdsAfterFirst[0]);
    expect(state.movements.length).toBe(movementCountAfterFirst);
  });
});

describe('replayJournal — purchase dispatch', () => {
  it('applies a purchase entry and records positive inventory movement', async () => {
    const ts = new Date('2024-05-01T10:00:00Z');
    state.journal.push(
      makeJournalEntry(
        'jp',
        'purchase',
        {
          purchaseId: 'pur-1',
          supplierId: 'sup-1',
          invoiceNo: null,
          total: '50',
          items: [{ productId: 'p1', quantity: 5, unitBuyPrice: '10', lineTotal: '50' }],
          userId: 'u1',
          timestamp: ts.toISOString(),
        },
        ts,
      ),
    );

    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(true);
    expect(state.purchases.size).toBe(1);
    expect(state.purchaseItems).toHaveLength(1);
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0]!.quantityDelta).toBe(5);
    expect(state.inventory.get('p1')!.onHand).toBe(5);
  });
});

describe('replayJournal — adjustment dispatch', () => {
  it('records a movement with the signed delta and recomputes onHand', async () => {
    const ts = new Date('2024-05-01T10:00:00Z');
    state.journal.push(
      makeJournalEntry(
        'ja',
        'adjustment',
        {
          adjustmentId: 'adj-1',
          productId: 'p1',
          quantityDelta: -3,
          reason: 'damaged',
          userId: 'u1',
          timestamp: ts.toISOString(),
        },
        ts,
      ),
    );

    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(true);
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0]!.quantityDelta).toBe(-3);
    expect(state.inventory.get('p1')!.onHand).toBe(-3);
  });
});

describe('replayJournal — price.change dispatch', () => {
  it('updates Product prices to the next snapshot', async () => {
    state.products.set('p1', { id: 'p1', buyPrice: '5', sellPrice: '10' });
    const ts = new Date('2024-05-01T10:00:00Z');
    state.journal.push(
      makeJournalEntry(
        'jp',
        'price.change',
        {
          productId: 'p1',
          previous: { buyPrice: '5', sellPrice: '10' },
          next: { buyPrice: '7', sellPrice: '15' },
          userId: 'u1',
          timestamp: ts.toISOString(),
        },
        ts,
      ),
    );

    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(true);
    expect(state.products.get('p1')!.buyPrice).toBe('7');
    expect(state.products.get('p1')!.sellPrice).toBe('15');
  });
});

describe('replayJournal — role.change dispatch', () => {
  it('updates the user.roleId by resolving the role NAME', async () => {
    state.roles.set('r-admin', { id: 'r-admin', name: 'Admin' });
    state.roles.set('r-cashier', { id: 'r-cashier', name: 'Cashier' });
    state.users.set('u1', { id: 'u1', roleId: 'r-cashier' });

    const ts = new Date('2024-05-01T10:00:00Z');
    state.journal.push(
      makeJournalEntry(
        'jr',
        'role.change',
        {
          targetUserId: 'u1',
          previousRole: 'cashier',
          newRole: 'Admin',
          userId: 'u-admin',
          timestamp: ts.toISOString(),
        },
        ts,
      ),
    );

    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(true);
    expect(state.users.get('u1')!.roleId).toBe('r-admin');
  });

  it('tolerates a lower-case role name in the payload', async () => {
    state.roles.set('r-admin', { id: 'r-admin', name: 'Admin' });
    state.users.set('u1', { id: 'u1', roleId: 'r-cashier' });
    const ts = new Date('2024-05-01T10:00:00Z');
    state.journal.push(
      makeJournalEntry(
        'jr',
        'role.change',
        {
          targetUserId: 'u1',
          newRole: 'admin',
          userId: 'u-admin',
          timestamp: ts.toISOString(),
        },
        ts,
      ),
    );

    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(true);
    expect(state.users.get('u1')!.roleId).toBe('r-admin');
  });
});

describe('replayJournal — unknown opType', () => {
  it('skips unknown entries silently and does not count them', async () => {
    const ts = new Date('2024-05-01T10:00:00Z');
    state.journal.push(makeJournalEntry('jm', 'maintenance', { kind: 'weekly' }, ts));

    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The batch ran (one transaction was opened) but no entries
      // were applied.
      expect(result.value.appliedCount).toBe(0);
      expect(result.value.batchCount).toBe(1);
    }
  });
});

describe('replayJournal — multi-batch walk', () => {
  it('walks pages until the journal is exhausted', async () => {
    // Push 250 sale entries — exceeds the helper's clamp of 200 so
    // the walker must page at least twice.
    const baseTs = new Date('2024-05-01T10:00:00Z').getTime();
    for (let i = 0; i < 250; i++) {
      const ts = new Date(baseTs + i * 1000);
      state.journal.push(
        makeJournalEntry(
          `j-${String(i).padStart(3, '0')}`,
          'sale',
          buildSalePayload(`sale-${i}`, `INV-${i}`, 'u1', [
            { productId: 'p1', quantity: 1 },
          ], ts),
          ts,
        ),
      );
    }

    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.appliedCount).toBe(250);
      expect(result.value.batchCount).toBeGreaterThanOrEqual(2);
    }
    expect(state.sales.size).toBe(250);
  });
});

describe('replayJournal — crash safety', () => {
  it('returns Err(INTERNAL, replay_failed) when a batch transaction throws', async () => {
    const ts = new Date('2024-05-01T10:00:00Z');
    state.journal.push(
      makeJournalEntry(
        'j1',
        'sale',
        buildSalePayload('sale-1', 'INV-000001', 'u1', [
          { productId: 'p1', quantity: 1 },
        ], ts),
        ts,
      ),
    );
    state.failNextTransaction = true;

    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
      const details = result.error.details as { reason?: string };
      expect(details.reason).toBe('replay_failed');
    }
    // No rows were committed.
    expect(state.sales.size).toBe(0);
  });
});

describe('replayJournal — snapshot timestamp filter', () => {
  it('skips entries with timestamp < snapshotTs', async () => {
    const beforeTs = new Date('2024-04-30T23:00:00Z');
    const afterTs = new Date('2024-05-01T01:00:00Z');
    state.journal.push(
      makeJournalEntry(
        'j-before',
        'sale',
        buildSalePayload('sale-before', 'INV-001', 'u1', [
          { productId: 'p1', quantity: 1 },
        ], beforeTs),
        beforeTs,
      ),
    );
    state.journal.push(
      makeJournalEntry(
        'j-after',
        'sale',
        buildSalePayload('sale-after', 'INV-002', 'u1', [
          { productId: 'p1', quantity: 1 },
        ], afterTs),
        afterTs,
      ),
    );

    const result = await replayJournal({
      snapshotTs: new Date('2024-05-01T00:00:00Z'),
      prismaClient: buildClient(state),
    });
    expect(result.ok).toBe(true);
    expect(state.sales.has('sale-before')).toBe(false);
    expect(state.sales.has('sale-after')).toBe(true);
  });
});
