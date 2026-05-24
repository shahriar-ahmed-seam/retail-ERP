import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `POSService` (Phase 7, tasks 7.2 + 7.3 + 7.4).
 *
 * Three surfaces:
 *
 *   - `scan(barcode)` — drives an in-memory mock of
 *     `prisma.product.findUnique` (with the standard
 *     `{ inventory, category }` includes) so the service's mapping
 *     to the wire DTO is exercised against the same payload shape
 *     production sees. The mock follows the conventions used by
 *     `tests/unit/main/services/product.service.test.ts` —
 *     `vi.hoisted` state, `Prisma.Decimal` reused from the real
 *     `@prisma/client` package.
 *
 *   - `nextSerial(tx)` — drives a fake `TransactionClient` whose
 *     `setting.findUniqueOrThrow` and `setting.update` operate on
 *     an in-memory `Setting` row. Verifies the format
 *     (`INV-XXXXXX`, no truncation past 999999), that the new value
 *     is persisted via `tx`, and that a corrupted (non-numeric)
 *     counter throws so the surrounding `$transaction` rolls back.
 *
 *   - `finalizeSale(input, ctx)` — drives the full atomic write
 *     path against the in-memory Prisma mock's `$transaction`. The
 *     mock snapshots/rolls-back state on a thrown exception so
 *     tests can observe the all-or-nothing semantics: on any
 *     failure, no Sale/SaleItem/Payment/InventoryMovement/JournalEntry
 *     is left behind. Mirrors the purchase service test mocking
 *     pattern (see `purchase.service.test.ts`).
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.9, 11.1,
 *            12.1, 12.2.
 */

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  interface MockProduct {
    id: string;
    sku: string;
    name: string;
    categoryId: string;
    barcode: string | null;
    buyPrice: string;
    sellPrice: string;
    taxRate: string;
    warrantyMonths: number;
    reorderLevel: number;
  }
  interface MockInventory {
    productId: string;
    onHand: number;
    updatedAt: Date;
  }
  interface MockCategory {
    id: string;
    name: string;
  }
  interface MockCustomer {
    id: string;
    name: string;
  }
  interface MockUser {
    id: string;
    username: string;
  }
  interface MockSetting {
    key: string;
    value: string;
  }
  interface MockSale {
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
  interface MockSaleItem {
    id: string;
    saleId: string;
    productId: string;
    quantity: number;
    unitPrice: string;
    taxRate: string;
    lineTotal: string;
  }
  interface MockPayment {
    id: string;
    saleId: string;
    method: string;
    amount: string;
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

  const state = {
    products: [] as MockProduct[],
    inventories: [] as MockInventory[],
    categories: [] as MockCategory[],
    customers: [] as MockCustomer[],
    users: [] as MockUser[],
    settings: [] as MockSetting[],
    sales: [] as MockSale[],
    saleItems: [] as MockSaleItem[],
    payments: [] as MockPayment[],
    movements: [] as MockMovement[],
    journalEntries: [] as MockJournalEntry[],
    nextSaleId: 0,
    nextSaleItemId: 0,
    nextPaymentId: 0,
    nextMovementId: 0,
    nextJournalId: 0,
  };

  return {
    state,
    reset(): void {
      state.products = [];
      state.inventories = [];
      state.categories = [];
      state.customers = [];
      state.users = [];
      state.settings = [];
      state.sales = [];
      state.saleItems = [];
      state.payments = [];
      state.movements = [];
      state.journalEntries = [];
      state.nextSaleId = 0;
      state.nextSaleItemId = 0;
      state.nextPaymentId = 0;
      state.nextMovementId = 0;
      state.nextJournalId = 0;
    },
  };
});

vi.mock('@main/db/prisma.js', async () => {
  const { Prisma } = await import('@prisma/client');
  const { state } = mockState;

  type MockProduct = (typeof state.products)[number];

  function makeKnownError(code: string, message: string): unknown {
    return new Prisma.PrismaClientKnownRequestError(message, {
      code,
      clientVersion: 'test',
    });
  }

  // ---- Product (read-side: scan) ---------------------------------------
  function attachJoins(
    row: MockProduct,
    include?: { inventory?: boolean; category?: { select?: { name?: boolean } } | boolean },
  ): unknown {
    const inv = state.inventories.find((i) => i.productId === row.id) ?? null;
    const cat = state.categories.find((c) => c.id === row.categoryId) ?? null;
    const out: {
      id: string;
      sku: string;
      name: string;
      categoryId: string;
      barcode: string | null;
      buyPrice: import('@prisma/client').Prisma.Decimal;
      sellPrice: import('@prisma/client').Prisma.Decimal;
      taxRate: import('@prisma/client').Prisma.Decimal;
      warrantyMonths: number;
      reorderLevel: number;
      inventory?: typeof inv;
      category?: { name: string } | null;
    } = {
      id: row.id,
      sku: row.sku,
      name: row.name,
      categoryId: row.categoryId,
      barcode: row.barcode,
      buyPrice: new Prisma.Decimal(row.buyPrice),
      sellPrice: new Prisma.Decimal(row.sellPrice),
      taxRate: new Prisma.Decimal(row.taxRate),
      warrantyMonths: row.warrantyMonths,
      reorderLevel: row.reorderLevel,
    };
    if (include?.inventory === true) {
      out.inventory = inv;
    }
    if (include?.category) {
      out.category = cat ? { name: cat.name } : null;
    }
    return out;
  }

  function productFindUnique({
    where,
    include,
  }: {
    where: { id?: string; barcode?: string; sku?: string };
    include?: { inventory?: boolean; category?: { select?: { name?: boolean } } | boolean };
  }): Promise<unknown> {
    const row = state.products.find(
      (r) =>
        (where.id !== undefined && r.id === where.id) ||
        (where.barcode !== undefined && r.barcode === where.barcode) ||
        (where.sku !== undefined && r.sku === where.sku),
    );
    if (!row) return Promise.resolve(null);
    return Promise.resolve(attachJoins(row, include));
  }

  // ---- Setting (used by nextSerial) ------------------------------------
  function settingFindUniqueOrThrow({ where }: { where: { key: string } }): Promise<unknown> {
    const row = state.settings.find((s) => s.key === where.key);
    if (!row) throw makeKnownError('P2025', 'No Setting found');
    return Promise.resolve({ ...row });
  }

  function settingUpdate({
    where,
    data,
  }: {
    where: { key: string };
    data: { value: string };
  }): Promise<unknown> {
    const row = state.settings.find((s) => s.key === where.key);
    if (!row) throw makeKnownError('P2025', 'No Setting found');
    row.value = data.value;
    return Promise.resolve({ ...row });
  }

  // ---- Customer (FK check inside finalizeSale) -------------------------
  function customerFindUniqueOrThrow({
    where,
  }: {
    where: { id: string };
  }): Promise<unknown> {
    const row = state.customers.find((c) => c.id === where.id);
    if (!row) throw makeKnownError('P2025', 'No Customer found');
    return Promise.resolve({ ...row });
  }

  // ---- Inventory + InventoryMovement (used by applyMovement) -----------
  function inventoryFindUniqueOrThrow({
    where,
  }: {
    where: { productId: string };
  }): Promise<unknown> {
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
  }): Promise<unknown> {
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
  }): Promise<unknown> {
    const row = {
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

  // ---- Sale (nested create with items + payments + joins) --------------
  function saleCreate({
    data,
    include,
  }: {
    data: {
      serialNo: string;
      customerId: string | null;
      cashierId: string;
      subtotal: { toString(): string };
      discount: { toString(): string };
      taxTotal: { toString(): string };
      grandTotal: { toString(): string };
      items?: { create: { productId: string; quantity: number; unitPrice: { toString(): string }; taxRate: { toString(): string }; lineTotal: { toString(): string } }[] };
      payments?: { create: { method: string; amount: { toString(): string } }[] };
    };
    include?: {
      items?: boolean | { include?: { product?: { select?: { name?: boolean } } } };
      payments?: boolean;
      customer?: boolean | { select?: { name?: boolean } };
      cashier?: boolean | { select?: { username?: boolean } };
    };
  }): Promise<unknown> {
    // Defensive uniqueness check on serialNo — the schema enforces
    // it, so we surface the same Prisma P2002 here when violated.
    if (state.sales.some((s) => s.serialNo === data.serialNo)) {
      throw makeKnownError('P2002', 'Unique constraint failed on serialNo');
    }

    const saleId = `sale-${state.nextSaleId++}`;
    const now = new Date('2024-06-01T12:00:00.000Z');

    const sale = {
      id: saleId,
      serialNo: data.serialNo,
      customerId: data.customerId,
      cashierId: data.cashierId,
      subtotal: data.subtotal.toString(),
      discount: data.discount.toString(),
      taxTotal: data.taxTotal.toString(),
      grandTotal: data.grandTotal.toString(),
      createdAt: now,
    };
    state.sales.push(sale);

    // Nested items
    const itemRows: typeof state.saleItems = [];
    if (data.items?.create) {
      for (const it of data.items.create) {
        const row = {
          id: `si-${state.nextSaleItemId++}`,
          saleId,
          productId: it.productId,
          quantity: it.quantity,
          unitPrice: it.unitPrice.toString(),
          taxRate: it.taxRate.toString(),
          lineTotal: it.lineTotal.toString(),
        };
        state.saleItems.push(row);
        itemRows.push(row);
      }
    }

    // Nested payments
    const paymentRows: typeof state.payments = [];
    if (data.payments?.create) {
      for (const p of data.payments.create) {
        const row = {
          id: `pay-${state.nextPaymentId++}`,
          saleId,
          method: p.method,
          amount: p.amount.toString(),
        };
        state.payments.push(row);
        paymentRows.push(row);
      }
    }

    // Project the include shape onto the returned row.
    const out: Record<string, unknown> = {
      id: sale.id,
      serialNo: sale.serialNo,
      customerId: sale.customerId,
      cashierId: sale.cashierId,
      subtotal: new Prisma.Decimal(sale.subtotal),
      discount: new Prisma.Decimal(sale.discount),
      taxTotal: new Prisma.Decimal(sale.taxTotal),
      grandTotal: new Prisma.Decimal(sale.grandTotal),
      createdAt: sale.createdAt,
    };

    if (include?.items) {
      const itemsInclude = typeof include.items === 'object' ? include.items : undefined;
      out.items = itemRows.map((r) => {
        const item: Record<string, unknown> = {
          id: r.id,
          saleId: r.saleId,
          productId: r.productId,
          quantity: r.quantity,
          unitPrice: new Prisma.Decimal(r.unitPrice),
          taxRate: new Prisma.Decimal(r.taxRate),
          lineTotal: new Prisma.Decimal(r.lineTotal),
        };
        if (itemsInclude?.include?.product !== undefined) {
          const product = state.products.find((p) => p.id === r.productId);
          item.product = product ? { name: product.name } : { name: 'Unknown' };
        }
        return item;
      });
    }

    if (include?.payments) {
      out.payments = paymentRows.map((r) => ({
        id: r.id,
        saleId: r.saleId,
        method: r.method,
        amount: new Prisma.Decimal(r.amount),
      }));
    }

    if (include?.customer) {
      if (sale.customerId !== null) {
        const cust = state.customers.find((c) => c.id === sale.customerId);
        out.customer = cust ? { name: cust.name } : null;
      } else {
        out.customer = null;
      }
    }

    if (include?.cashier) {
      const user = state.users.find((u) => u.id === sale.cashierId);
      out.cashier = user ? { username: user.username } : { username: 'unknown' };
    }

    return Promise.resolve(out);
  }

  // ---- JournalEntry delegate -------------------------------------------
  function journalEntryCreate({
    data,
  }: {
    data: { opType: string; payload: string };
  }): Promise<unknown> {
    const row = {
      id: `journal-${state.nextJournalId++}`,
      opType: data.opType,
      payload: data.payload,
      timestamp: new Date(),
    };
    state.journalEntries.push(row);
    return Promise.resolve({ ...row });
  }

  // ---- Tx-shaped delegate map handed to `$transaction` callbacks -------
  // Mirrors the surface `finalizeSale` touches inside one
  // transaction:
  //   - `inventory.findUniqueOrThrow` + `inventory.update` +
  //     `inventoryMovement.create` (driven by both the explicit
  //     pre-check and `applyMovement`),
  //   - `setting.findUniqueOrThrow` + `setting.update` (driven by
  //     `nextSerial`),
  //   - `customer.findUniqueOrThrow` (FK check),
  //   - `sale.create` (header + nested items + nested payments + joins),
  //   - `journalEntry.create` for the replay payload.
  const tx = {
    setting: {
      findUniqueOrThrow: settingFindUniqueOrThrow,
      update: settingUpdate,
    },
    customer: {
      findUniqueOrThrow: customerFindUniqueOrThrow,
    },
    inventory: {
      findUniqueOrThrow: inventoryFindUniqueOrThrow,
      update: inventoryUpdate,
    },
    inventoryMovement: {
      create: inventoryMovementCreate,
    },
    sale: {
      create: saleCreate,
    },
    journalEntry: {
      create: journalEntryCreate,
    },
  };

  async function $transaction<T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> {
    // Snapshot mutable state so an in-tx throw rolls everything
    // back — matching Prisma's real `$transaction` semantics. This
    // is what makes "OUT_OF_STOCK leaves no row" observable: sale,
    // items, payments, movements, AND journal must all roll back
    // together.
    const snapshot = {
      sales: state.sales.map((s) => ({ ...s })),
      saleItems: state.saleItems.map((s) => ({ ...s })),
      payments: state.payments.map((p) => ({ ...p })),
      inventories: state.inventories.map((i) => ({ ...i })),
      movements: state.movements.map((m) => ({ ...m })),
      journalEntries: state.journalEntries.map((j) => ({ ...j })),
      settings: state.settings.map((s) => ({ ...s })),
      nextSaleId: state.nextSaleId,
      nextSaleItemId: state.nextSaleItemId,
      nextPaymentId: state.nextPaymentId,
      nextMovementId: state.nextMovementId,
      nextJournalId: state.nextJournalId,
    };
    try {
      return await cb(tx);
    } catch (err) {
      state.sales = snapshot.sales;
      state.saleItems = snapshot.saleItems;
      state.payments = snapshot.payments;
      state.inventories = snapshot.inventories;
      state.movements = snapshot.movements;
      state.journalEntries = snapshot.journalEntries;
      state.settings = snapshot.settings;
      state.nextSaleId = snapshot.nextSaleId;
      state.nextSaleItemId = snapshot.nextSaleItemId;
      state.nextPaymentId = snapshot.nextPaymentId;
      state.nextMovementId = snapshot.nextMovementId;
      state.nextJournalId = snapshot.nextJournalId;
      throw err;
    }
  }

  return {
    prisma: {
      product: {
        findUnique: productFindUnique,
      },
      setting: {
        findUniqueOrThrow: settingFindUniqueOrThrow,
        update: settingUpdate,
      },
      customer: {
        findUniqueOrThrow: customerFindUniqueOrThrow,
      },
      inventory: {
        findUniqueOrThrow: inventoryFindUniqueOrThrow,
        update: inventoryUpdate,
      },
      inventoryMovement: {
        create: inventoryMovementCreate,
      },
      sale: {
        create: saleCreate,
      },
      journalEntry: {
        create: journalEntryCreate,
      },
      $transaction,
    },
  };
});

// Imports MUST come after `vi.mock`.
import { POSService } from '@main/services/pos.service';

import type { Prisma } from '@prisma/client';
import type { FinalizeSaleInput } from '@shared/dto/index';

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

function seedCategory(id: string, name: string): void {
  mockState.state.categories.push({ id, name });
}

function seedProduct(
  overrides: Partial<{
    id: string;
    sku: string;
    name: string;
    categoryId: string;
    barcode: string | null;
    buyPrice: string;
    sellPrice: string;
    taxRate: string;
    warrantyMonths: number;
    reorderLevel: number;
    onHand: number;
  }> = {},
): string {
  const id = overrides.id ?? `prod-seed-${mockState.state.products.length}`;
  mockState.state.products.push({
    id,
    sku: overrides.sku ?? `SKU-${id}`,
    name: overrides.name ?? `Name ${id}`,
    categoryId: overrides.categoryId ?? 'cat-default',
    barcode: overrides.barcode ?? null,
    buyPrice: overrides.buyPrice ?? '10',
    sellPrice: overrides.sellPrice ?? '15',
    taxRate: overrides.taxRate ?? '0',
    warrantyMonths: overrides.warrantyMonths ?? 0,
    reorderLevel: overrides.reorderLevel ?? 0,
  });
  mockState.state.inventories.push({
    productId: id,
    onHand: overrides.onHand ?? 0,
    updatedAt: new Date(),
  });
  return id;
}

function seedCustomer(id: string, name = `Cust-${id}`): void {
  mockState.state.customers.push({ id, name });
}

function seedUser(id: string, username = `user-${id}`): void {
  mockState.state.users.push({ id, username });
}

function seedSerialCounter(value = '0'): void {
  mockState.state.settings.push({ key: 'sale.serialCounter', value });
}

beforeEach(() => {
  mockState.reset();
  seedCategory('cat-default', 'Default');
  seedCategory('cat-hardware', 'Hardware');
});

afterEach(() => {
  mockState.reset();
});

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

describe('POSService.scan', () => {
  it('returns the matching ProductDTO with the joined onHand projected', async () => {
    seedProduct({
      id: 'p-bar',
      sku: 'SKU-BAR',
      name: 'Bar Stock',
      categoryId: 'cat-hardware',
      barcode: '4002',
      buyPrice: '10.00',
      sellPrice: '15.00',
      taxRate: '0.18',
      warrantyMonths: 6,
      reorderLevel: 5,
      onHand: 12,
    });

    const dto = unwrapOk(await POSService.scan('4002'));
    expect(dto).not.toBeNull();
    expect(dto?.id).toBe('p-bar');
    expect(dto?.sku).toBe('SKU-BAR');
    expect(dto?.name).toBe('Bar Stock');
    expect(dto?.barcode).toBe('4002');
    expect(dto?.categoryId).toBe('cat-hardware');
    expect(dto?.categoryName).toBe('Hardware');
    expect(dto?.buyPrice).toBe('10');
    expect(dto?.sellPrice).toBe('15');
    expect(dto?.taxRate).toBe('0.18');
    expect(dto?.warrantyMonths).toBe(6);
    expect(dto?.reorderLevel).toBe(5);
    // Inventory.onHand is projected onto the wire row by the include
    // join — Property: every product has an inventory row.
    expect(dto?.onHand).toBe(12);
  });

  it('trims surrounding whitespace before the lookup (USB scanners often append CR/LF)', async () => {
    seedProduct({ id: 'p-trim', barcode: '12345', onHand: 3 });
    const dto = unwrapOk(await POSService.scan('   12345\n'));
    expect(dto?.id).toBe('p-trim');
    expect(dto?.onHand).toBe(3);
  });

  it('returns Ok(null) when no product owns the barcode (NOT an Err)', async () => {
    seedProduct({ id: 'p-1', barcode: '0001' });
    const result = await POSService.scan('does-not-exist');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it('returns Err(VALIDATION, { field: "barcode" }) on empty barcode', async () => {
    const result = await POSService.scan('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'barcode' });
    }
  });

  it('returns Err(VALIDATION, { field: "barcode" }) on whitespace-only barcode', async () => {
    const result = await POSService.scan('   \t\n  ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'barcode' });
    }
  });

  it('returns Err(VALIDATION) on a non-string barcode', async () => {
    // The IPC contract types `barcode` as string, but defence-in-depth
    // — a renderer bug or a future contract change should not crash
    // the main process or hand back a null masquerading as Ok.
    const result = await POSService.scan(123 as unknown as string);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.details).toEqual({ field: 'barcode' });
    }
  });
});

// ---------------------------------------------------------------------------
// nextSerial
// ---------------------------------------------------------------------------

/**
 * Build a fake `Prisma.TransactionClient` whose `setting.findUniqueOrThrow`
 * and `setting.update` operate on an in-memory `Setting` row.
 *
 * The shape only implements the two methods `nextSerial` actually
 * touches — the cast at the bottom narrows it to the type Prisma
 * expects. Production code never sees this; the real `tx` in the
 * `pos:finalize` transaction is constructed by Prisma.
 */
function makeFakeTx(initialValue: string | undefined): {
  tx: Prisma.TransactionClient;
  read(): string | undefined;
  updates: number;
} {
  let value = initialValue;
  let updates = 0;

  const tx = {
    setting: {
      findUniqueOrThrow: ({ where }: { where: { key: string } }) => {
        if (where.key !== 'sale.serialCounter') {
          // Surface a recognisable error so a wrong key in the service
          // shows up immediately in test output rather than silently
          // returning the seeded row.
          throw new Error(`unexpected setting key: ${where.key}`);
        }
        if (value === undefined) {
          // Mimic Prisma's P2025 — a `findUniqueOrThrow` on a missing
          // row throws this code in production. The service is meant
          // to let it propagate so the `$transaction` rolls back.
          const err = new Error('Record to update not found.');
          (err as unknown as { code: string }).code = 'P2025';
          throw err;
        }
        return Promise.resolve({ key: 'sale.serialCounter', value });
      },
      update: ({
        where,
        data,
      }: {
        where: { key: string };
        data: { value: string };
      }): Promise<unknown> => {
        if (where.key !== 'sale.serialCounter') {
          throw new Error(`unexpected setting key: ${where.key}`);
        }
        value = data.value;
        updates++;
        return Promise.resolve({ key: 'sale.serialCounter', value });
      },
    },
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    read: () => value,
    get updates() {
      return updates;
    },
  };
}

describe('POSService.nextSerial', () => {
  it('first call (counter="0") returns INV-000001 and persists "1"', async () => {
    const fake = makeFakeTx('0');
    const serial = await POSService.nextSerial(fake.tx);
    expect(serial).toBe('INV-000001');
    expect(fake.read()).toBe('1');
    expect(fake.updates).toBe(1);
  });

  it('mid-range (counter="42") returns INV-000043 and persists "43"', async () => {
    const fake = makeFakeTx('42');
    const serial = await POSService.nextSerial(fake.tx);
    expect(serial).toBe('INV-000043');
    expect(fake.read()).toBe('43');
  });

  it('exactly at the six-digit boundary (counter="99998") returns INV-099999', async () => {
    const fake = makeFakeTx('99998');
    const serial = await POSService.nextSerial(fake.tx);
    expect(serial).toBe('INV-099999');
    expect(fake.read()).toBe('99999');
  });

  it('counter="999999" rolls over to INV-1000000 — no truncation, monotonic past 999999', async () => {
    const fake = makeFakeTx('999999');
    const serial = await POSService.nextSerial(fake.tx);
    expect(serial).toBe('INV-1000000');
    expect(fake.read()).toBe('1000000');
  });

  it('successive calls on the same fake tx produce strictly increasing serials', async () => {
    const fake = makeFakeTx('0');
    const a = await POSService.nextSerial(fake.tx);
    const b = await POSService.nextSerial(fake.tx);
    const c = await POSService.nextSerial(fake.tx);
    expect([a, b, c]).toEqual(['INV-000001', 'INV-000002', 'INV-000003']);
    expect(fake.read()).toBe('3');
  });

  it('throws (DB_INTEGRITY) on a non-numeric counter and does NOT issue an update', async () => {
    const fake = makeFakeTx('not-a-number');
    await expect(POSService.nextSerial(fake.tx)).rejects.toThrow(/non-numeric/i);
    // Counter must stay untouched so the rolled-back transaction
    // leaves the persisted row at its corrupt-but-original value
    // for the operator to investigate.
    expect(fake.read()).toBe('not-a-number');
    expect(fake.updates).toBe(0);
  });

  it('throws on a decimal counter (".5", "1.0"); the only writers produce integer strings', async () => {
    const fake = makeFakeTx('1.0');
    await expect(POSService.nextSerial(fake.tx)).rejects.toThrow(/non-numeric/i);
    expect(fake.updates).toBe(0);
  });

  it('propagates Prisma P2025 when the counter row is missing (data-integrity bug)', async () => {
    // The seed always creates the `sale.serialCounter` row, so a
    // missing row indicates corruption — the service lets the error
    // propagate so the surrounding `$transaction` rolls back.
    const fake = makeFakeTx(undefined);
    await expect(POSService.nextSerial(fake.tx)).rejects.toMatchObject({
      code: 'P2025',
    });
    expect(fake.updates).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// finalizeSale (Phase 7, task 7.4)
// ---------------------------------------------------------------------------

const ctx = { userId: 'u-cashier' };

/** Build a single-line, no-discount, no-tax happy-path input. */
function makeSimpleInput(
  overrides: Partial<FinalizeSaleInput> = {},
): FinalizeSaleInput {
  const items =
    overrides.items ??
    ([
      {
        productId: 'p-1',
        quantity: 2,
        unitPrice: '10.00',
        taxRate: '0',
        lineTotal: '20.00',
      },
    ] as const);
  const payments =
    overrides.payments ?? ([{ method: 'cash' as const, amount: '20.00' }] as const);
  return {
    customerId: overrides.customerId !== undefined ? overrides.customerId : null,
    items,
    discount: overrides.discount ?? { kind: 'fixed', amount: '0' },
    subtotal: overrides.subtotal ?? '20',
    discountAmount: overrides.discountAmount ?? '0',
    taxTotal: overrides.taxTotal ?? '0',
    grandTotal: overrides.grandTotal ?? '20',
    payments,
  };
}

describe('POSService.finalizeSale: surface', () => {
  it('exposes finalizeSale on the service literal', () => {
    expect(typeof POSService.finalizeSale).toBe('function');
  });

  it('the service literal is frozen', () => {
    expect(Object.isFrozen(POSService)).toBe(true);
  });
});

describe('POSService.finalizeSale: validation (Req 4.4, 4.5, 4.6)', () => {
  beforeEach(() => {
    seedSerialCounter('0');
    seedUser('u-cashier', 'cashier1');
    seedProduct({ id: 'p-1', name: 'Hammer', sellPrice: '10', taxRate: '0', onHand: 100 });
  });

  it('rejects empty items array with VALIDATION { field: "items" }', async () => {
    const input = makeSimpleInput({ items: [], subtotal: '0', grandTotal: '0' });
    const result = await POSService.finalizeSale(input, ctx);
    expectErr(result, 'VALIDATION', { field: 'items' });
    expect(mockState.state.sales).toHaveLength(0);
  });

  it('rejects empty payments array with VALIDATION { field: "payments" }', async () => {
    const input = makeSimpleInput({ payments: [] });
    const result = await POSService.finalizeSale(input, ctx);
    expectErr(result, 'VALIDATION', { field: 'payments' });
    expect(mockState.state.sales).toHaveLength(0);
  });

  it('rejects per-line lineTotal mismatch with VALIDATION { field: "items[0].lineTotal" }', async () => {
    // quantity=2, unitPrice=10 → expected lineTotal=20; we send 30.
    const input = makeSimpleInput({
      items: [
        {
          productId: 'p-1',
          quantity: 2,
          unitPrice: '10.00',
          taxRate: '0',
          lineTotal: '30.00',
        },
      ],
    });
    const result = await POSService.finalizeSale(input, ctx);
    expectErr(result, 'VALIDATION', { field: 'items[0].lineTotal' });
  });

  it('rejects negative quantity with VALIDATION { field: "items[N].quantity" }', async () => {
    const input = makeSimpleInput({
      items: [
        {
          productId: 'p-1',
          quantity: -1,
          unitPrice: '10',
          taxRate: '0',
          lineTotal: '-10',
        },
      ],
      subtotal: '-10',
      grandTotal: '-10',
      payments: [{ method: 'cash', amount: '-10' }],
    });
    const result = await POSService.finalizeSale(input, ctx);
    expectErr(result, 'VALIDATION', { field: 'items[0].quantity' });
  });

  it('rejects empty productId with VALIDATION { field: "items[N].productId" }', async () => {
    const input = makeSimpleInput({
      items: [
        {
          productId: '',
          quantity: 1,
          unitPrice: '10',
          taxRate: '0',
          lineTotal: '10',
        },
      ],
      subtotal: '10',
      grandTotal: '10',
      payments: [{ method: 'cash', amount: '10' }],
    });
    const result = await POSService.finalizeSale(input, ctx);
    expectErr(result, 'VALIDATION', { field: 'items[0].productId' });
  });

  it('rejects unparseable unitPrice with VALIDATION { field: "items[N].unitPrice" }', async () => {
    const input = makeSimpleInput({
      items: [
        {
          productId: 'p-1',
          quantity: 1,
          unitPrice: 'free!',
          taxRate: '0',
          lineTotal: '0',
        },
      ],
      subtotal: '0',
      grandTotal: '0',
      payments: [{ method: 'cash', amount: '0' }],
    });
    const result = await POSService.finalizeSale(input, ctx);
    expectErr(result, 'VALIDATION', { field: 'items[0].unitPrice' });
  });

  it('rejects an invalid payment method with VALIDATION { field: "payments[N].method" }', async () => {
    const input = makeSimpleInput({
      payments: [{ method: 'crypto' as unknown as 'cash', amount: '20' }],
    });
    const result = await POSService.finalizeSale(input, ctx);
    expectErr(result, 'VALIDATION', { field: 'payments[0].method' });
  });

  it('rejects a malformed discount shape with VALIDATION { field: "discount" }', async () => {
    const input = makeSimpleInput({
      discount: { kind: 'gift' as unknown as 'fixed', amount: '0' },
    });
    const result = await POSService.finalizeSale(input, ctx);
    expectErr(result, 'VALIDATION', { field: 'discount' });
  });

  it('rejects tampered grandTotal with VALIDATION { field: "grandTotal", expected, actual }', async () => {
    // expected grand total = 20; we ship 99.
    const input = makeSimpleInput({ grandTotal: '99' });
    const result = await POSService.finalizeSale(input, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      const details = result.error.details as Record<string, unknown>;
      expect(details.field).toBe('grandTotal');
      expect(details.expected).toBe('20');
      expect(details.actual).toBe('99');
    }
  });

  it('rejects payments-sum mismatch with VALIDATION { field: "payments" }', async () => {
    // grand total = 20; payment sum = 5.
    const input = makeSimpleInput({
      payments: [{ method: 'cash', amount: '5' }],
    });
    const result = await POSService.finalizeSale(input, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      const details = result.error.details as Record<string, unknown>;
      expect(details.field).toBe('payments');
    }
  });

  it('rejects subtotal mismatch with VALIDATION { field: "subtotal" }', async () => {
    const input = makeSimpleInput({ subtotal: '99', grandTotal: '99' });
    const result = await POSService.finalizeSale(input, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      const details = result.error.details as Record<string, unknown>;
      expect(details.field).toBe('subtotal');
      expect(details.expected).toBe('20');
    }
  });

  it('does not write any rows on a validation failure', async () => {
    const input = makeSimpleInput({ items: [] });
    await POSService.finalizeSale(input, ctx);
    expect(mockState.state.sales).toHaveLength(0);
    expect(mockState.state.saleItems).toHaveLength(0);
    expect(mockState.state.payments).toHaveLength(0);
    expect(mockState.state.movements).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });
});

describe('POSService.finalizeSale: happy path (Req 4.2, 4.3, 4.4, 4.6, 11.1)', () => {
  beforeEach(() => {
    seedSerialCounter('0');
    seedUser('u-cashier', 'cashier1');
    seedProduct({
      id: 'p-1',
      name: 'Hammer',
      sellPrice: '10',
      taxRate: '0',
      onHand: 100,
    });
  });

  it('returns Ok({ saleId, serialNo, sale }) and writes sale + item + payment + movement + journal', async () => {
    const result = await POSService.finalizeSale(makeSimpleInput(), ctx);

    const value = unwrapOk(result);
    expect(typeof value.saleId).toBe('string');
    expect(value.saleId.length).toBeGreaterThan(0);
    expect(value.serialNo).toBe('INV-000001');

    expect(mockState.state.sales).toHaveLength(1);
    expect(mockState.state.saleItems).toHaveLength(1);
    expect(mockState.state.payments).toHaveLength(1);
    expect(mockState.state.movements).toHaveLength(1);
    expect(mockState.state.journalEntries).toHaveLength(1);

    const sale = mockState.state.sales[0]!;
    expect(sale.id).toBe(value.saleId);
    expect(sale.serialNo).toBe('INV-000001');
    expect(sale.cashierId).toBe('u-cashier');
    expect(sale.customerId).toBeNull();
    expect(sale.subtotal).toBe('20');
    expect(sale.discount).toBe('0');
    expect(sale.taxTotal).toBe('0');
    expect(sale.grandTotal).toBe('20');
  });

  it('persists the SaleItem with the correct quantity, unitPrice, taxRate, lineTotal', async () => {
    await POSService.finalizeSale(makeSimpleInput(), ctx);
    const item = mockState.state.saleItems[0]!;
    expect(item.productId).toBe('p-1');
    expect(item.quantity).toBe(2);
    expect(item.unitPrice).toBe('10');
    expect(item.taxRate).toBe('0');
    expect(item.lineTotal).toBe('20');
  });

  it('persists the Payment with method and amount intact', async () => {
    await POSService.finalizeSale(makeSimpleInput(), ctx);
    const payment = mockState.state.payments[0]!;
    expect(payment.method).toBe('cash');
    expect(payment.amount).toBe('20');
  });

  it('decrements Inventory.onHand by quantity and writes one negative-delta sale movement (Req 11.4)', async () => {
    await POSService.finalizeSale(makeSimpleInput(), ctx);
    const inv = mockState.state.inventories.find((i) => i.productId === 'p-1');
    expect(inv?.onHand).toBe(98); // 100 - 2

    const movement = mockState.state.movements[0]!;
    expect(movement.productId).toBe('p-1');
    expect(movement.quantityDelta).toBe(-2);
    expect(movement.movementType).toBe('sale');
    expect(movement.referenceType).toBe('sale');
    expect(movement.referenceId).toBe(mockState.state.sales[0]!.id);
    expect(movement.userId).toBe('u-cashier');
  });

  it('writes one journal entry of opType "sale" with a replay-friendly payload', async () => {
    const result = await POSService.finalizeSale(makeSimpleInput(), ctx);
    const value = unwrapOk(result);

    expect(mockState.state.journalEntries).toHaveLength(1);
    const entry = mockState.state.journalEntries[0]!;
    expect(entry.opType).toBe('sale');

    const payload = JSON.parse(entry.payload) as {
      saleId: string;
      serialNo: string;
      customerId: string | null;
      cashierId: string;
      subtotal: string;
      discount: string;
      taxTotal: string;
      grandTotal: string;
      items: { productId: string; quantity: number; unitPrice: string; taxRate: string; lineTotal: string }[];
      payments: { method: string; amount: string }[];
      userId: string;
      timestamp: string;
    };
    expect(payload.saleId).toBe(value.saleId);
    expect(payload.serialNo).toBe('INV-000001');
    expect(payload.customerId).toBeNull();
    expect(payload.cashierId).toBe('u-cashier');
    expect(payload.subtotal).toBe('20');
    expect(payload.grandTotal).toBe('20');
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toEqual({
      productId: 'p-1',
      quantity: 2,
      unitPrice: '10.00',
      taxRate: '0',
      lineTotal: '20.00',
    });
    expect(payload.payments).toEqual([{ method: 'cash', amount: '20.00' }]);
    expect(payload.userId).toBe('u-cashier');
    expect(typeof payload.timestamp).toBe('string');
  });

  it('returns a SaleDTO populated from the joined row (cashierName, items.productName, payments)', async () => {
    const result = await POSService.finalizeSale(makeSimpleInput(), ctx);
    const value = unwrapOk(result);

    expect(value.sale.id).toBe(value.saleId);
    expect(value.sale.serialNo).toBe('INV-000001');
    expect(value.sale.customerId).toBeNull();
    expect(value.sale.customerName).toBeNull();
    expect(value.sale.cashierId).toBe('u-cashier');
    expect(value.sale.cashierName).toBe('cashier1');
    expect(value.sale.subtotal).toBe('20');
    expect(value.sale.discount).toBe('0');
    expect(value.sale.taxTotal).toBe('0');
    expect(value.sale.grandTotal).toBe('20');
    expect(value.sale.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(value.sale.items).toHaveLength(1);
    const item = value.sale.items[0]!;
    expect(item.productId).toBe('p-1');
    expect(item.productName).toBe('Hammer');
    expect(item.quantity).toBe(2);
    expect(item.unitPrice).toBe('10');
    expect(item.taxRate).toBe('0');
    expect(item.lineTotal).toBe('20');

    expect(value.sale.payments).toHaveLength(1);
    expect(value.sale.payments[0]!.method).toBe('cash');
    expect(value.sale.payments[0]!.amount).toBe('20');
  });

  it('allocates the next monotonic serial — second finalize gets INV-000002', async () => {
    seedProduct({ id: 'p-2', sellPrice: '5', taxRate: '0', onHand: 50 });

    const first = await POSService.finalizeSale(makeSimpleInput(), ctx);
    expect(unwrapOk(first).serialNo).toBe('INV-000001');

    const secondInput = makeSimpleInput({
      items: [
        {
          productId: 'p-2',
          quantity: 1,
          unitPrice: '5',
          taxRate: '0',
          lineTotal: '5',
        },
      ],
      subtotal: '5',
      grandTotal: '5',
      payments: [{ method: 'cash', amount: '5' }],
    });
    const second = await POSService.finalizeSale(secondInput, ctx);
    expect(unwrapOk(second).serialNo).toBe('INV-000002');

    expect(mockState.state.sales.map((s) => s.serialNo)).toEqual([
      'INV-000001',
      'INV-000002',
    ]);
  });

  it('attaches a customer when customerId is provided', async () => {
    seedCustomer('c-1', 'Walk-in');

    const input = makeSimpleInput({ customerId: 'c-1' });
    const result = await POSService.finalizeSale(input, ctx);
    const value = unwrapOk(result);

    expect(value.sale.customerId).toBe('c-1');
    expect(value.sale.customerName).toBe('Walk-in');
    expect(mockState.state.sales[0]!.customerId).toBe('c-1');
  });
});

describe('POSService.finalizeSale: OUT_OF_STOCK (Req 4.9, 11.1)', () => {
  beforeEach(() => {
    seedSerialCounter('0');
    seedUser('u-cashier', 'cashier1');
  });

  it('returns Err(OUT_OF_STOCK, { productId }) when onHand < quantity, and writes nothing', async () => {
    seedProduct({
      id: 'p-1',
      name: 'Hammer',
      sellPrice: '10',
      taxRate: '0',
      onHand: 1, // requested quantity = 2
    });

    const result = await POSService.finalizeSale(makeSimpleInput(), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('OUT_OF_STOCK');
      expect(result.error.details).toEqual({ productId: 'p-1' });
    }

    // All-or-nothing: the surrounding $transaction rolled back, so
    // no Sale, SaleItem, Payment, InventoryMovement, or JournalEntry
    // is left behind. Inventory.onHand is unchanged.
    expect(mockState.state.sales).toHaveLength(0);
    expect(mockState.state.saleItems).toHaveLength(0);
    expect(mockState.state.payments).toHaveLength(0);
    expect(mockState.state.movements).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
    expect(mockState.state.inventories.find((i) => i.productId === 'p-1')?.onHand).toBe(1);
  });
});

describe('POSService.finalizeSale: FK_VIOLATION (Req 4.9)', () => {
  beforeEach(() => {
    seedSerialCounter('0');
    seedUser('u-cashier', 'cashier1');
    seedProduct({ id: 'p-1', sellPrice: '10', taxRate: '0', onHand: 100 });
  });

  it('returns Err(FK_VIOLATION, { reason: "not_found" }) when customerId is unknown', async () => {
    const input = makeSimpleInput({ customerId: 'c-missing' });
    const result = await POSService.finalizeSale(input, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
    // Nothing persisted.
    expect(mockState.state.sales).toHaveLength(0);
    expect(mockState.state.movements).toHaveLength(0);
    expect(mockState.state.journalEntries).toHaveLength(0);
  });

  it('returns Err(FK_VIOLATION, { reason: "not_found" }) when productId is unknown', async () => {
    const input = makeSimpleInput({
      items: [
        {
          productId: 'p-missing',
          quantity: 1,
          unitPrice: '10',
          taxRate: '0',
          lineTotal: '10',
        },
      ],
      subtotal: '10',
      grandTotal: '10',
      payments: [{ method: 'cash', amount: '10' }],
    });
    const result = await POSService.finalizeSale(input, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FK_VIOLATION');
      expect(result.error.details).toEqual({ reason: 'not_found' });
    }
  });
});
